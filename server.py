import base64
import copy
import json
import os
import time
import uuid
from typing import List

from dotenv import load_dotenv
from flask import Flask, jsonify, send_from_directory, request
from flask_socketio import SocketIO
from werkzeug.utils import secure_filename

from ai import detect_media_type, get_ai_client, global_job_manager
from ai.deepseek_client import DeepSeekError
from ai.enhancement import enhance_media

app = Flask(__name__, static_folder='public', template_folder='public')
app.config['SECRET_KEY'] = 'secret!'
# 使用eventlet作为异步服务
async_mode = 'eventlet'
socketio = SocketIO(app, async_mode=async_mode, cors_allowed_origins='*')

# 存储所有连接的节点信息
nodes = {}

load_dotenv()

UPLOAD_DIR = os.path.join(os.getcwd(), 'ai_uploads')
os.makedirs(UPLOAD_DIR, exist_ok=True)

REALTIME_SESSIONS = {}

ANALYSIS_TASK_KEYS = {'auto_tag', 'scene', 'emotion', 'understanding', 'recommendation'}
MODERATION_TASK_KEYS = {'moderation', 'audit', 'safety'}
SUBTITLE_TASK_KEYS = {'subtitles', 'caption', 'transcription'}
ENHANCEMENT_TASK_KEYS = {'enhancement', 'restore', 'super_resolution', 'denoise'}


def parse_list_field(value) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
        return [item.strip() for item in value.split(',') if item.strip()]
    return [str(value).strip()]


def save_upload(file_storage) -> str:
    filename = secure_filename(file_storage.filename)
    unique_name = f"{uuid.uuid4().hex}_{filename}" if filename else uuid.uuid4().hex
    file_path = os.path.join(UPLOAD_DIR, unique_name)
    file_storage.save(file_path)
    return file_path


def schedule_subtitle_job(file_path: str, descriptor, languages: List[str]):
    descriptor_copy = copy.deepcopy(descriptor)

    def _runner():
        client = get_ai_client()
        payload = client.generate_subtitles(file_path, descriptor_copy, languages)
        return {"type": "subtitles", "payload": payload}

    return global_job_manager.submit("generate-subtitles", _runner)


def schedule_enhancement_job(file_path: str, descriptor):
    descriptor_copy = copy.deepcopy(descriptor)

    def _runner():
        payload = enhance_media(file_path, descriptor_copy)
        return {"type": "enhancement", "payload": payload}

    return global_job_manager.submit("enhance-media", _runner)


def extract_latest_line_from_srt(srt_text: str) -> str:
    if not srt_text:
        return ""
    blocks = [block.strip() for block in srt_text.strip().split('\n\n') if block.strip()]
    if not blocks:
        return ""
    lines = blocks[-1].splitlines()
    if len(lines) >= 3:
        return lines[-1]
    return lines[-1] if lines else ""

@app.route('/')
def index():
    # 直接返回index.html文件
    return send_from_directory('public', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    # 提供静态文件服务
    return send_from_directory('public', path)


@app.route('/api/ai/config', methods=['GET'])
def ai_config():
    client = get_ai_client()
    return jsonify({
        'configured': client.is_configured,
        'features': {
            'analysis': True,
            'moderation': True,
            'subtitles': True,
            'realtimeSubtitles': True,
            'enhancement': True,
        }
    })


@app.route('/api/ai/analyze', methods=['POST'])
def ai_analyze():
    payload = request.get_json(silent=True) if request.is_json else {}
    upload = request.files.get('file')
    if not upload:
        return jsonify({'error': '缺少文件上传'}), 400

    form_tasks = request.form.getlist('tasks')
    tasks = parse_list_field(form_tasks or request.form.get('tasks') or (payload.get('tasks') if isinstance(payload, dict) else None))
    if not tasks:
        tasks = ['auto_tag', 'scene', 'emotion', 'moderation']

    form_languages = request.form.getlist('languages')
    languages = parse_list_field(form_languages or request.form.get('languages') or (payload.get('languages') if isinstance(payload, dict) else None))
    if not languages:
        languages = ['zh', 'en']

    try:
        file_path = save_upload(upload)
        descriptor = detect_media_type(upload.filename, upload.mimetype)
        descriptor.size_bytes = os.path.getsize(file_path)

        client = get_ai_client()

        analysis_requested = any(task in ANALYSIS_TASK_KEYS for task in tasks) or not tasks
        moderation_requested = any(task in MODERATION_TASK_KEYS for task in tasks)
        subtitles_requested = any(task in SUBTITLE_TASK_KEYS for task in tasks)
        enhancement_requested = any(task in ENHANCEMENT_TASK_KEYS for task in tasks)

        response_data = {
            'fileName': upload.filename,
            'mediaType': descriptor.media_type,
            'languages': languages,
            'tasks': tasks,
            'analysis': None,
            'moderation': None,
            'jobs': []
        }

        if analysis_requested or moderation_requested:
            analysis_result = client.analyze_media(file_path, descriptor, tasks, languages)
            response_data['analysis'] = analysis_result
            response_data['moderation'] = analysis_result.get('moderation')

        if moderation_requested and response_data['moderation'] is None:
            response_data['moderation'] = client.moderate_media(file_path, descriptor)

        if subtitles_requested:
            job = schedule_subtitle_job(file_path, descriptor, languages)
            response_data['jobs'].append({
                'jobId': job.job_id,
                'label': job.label,
                'status': job.status,
                'type': 'subtitles'
            })

        if enhancement_requested:
            job = schedule_enhancement_job(file_path, descriptor)
            response_data['jobs'].append({
                'jobId': job.job_id,
                'label': job.label,
                'status': job.status,
                'type': 'enhancement'
            })

        return jsonify(response_data)
    except DeepSeekError as exc:
        return jsonify({'error': str(exc)}), 502
    except Exception as exc:  # pragma: no cover - runtime safety
        return jsonify({'error': str(exc)}), 500


@app.route('/api/ai/jobs/<job_id>', methods=['GET'])
def ai_job_status(job_id):
    job = global_job_manager.get(job_id)
    if not job:
        return jsonify({'error': '未找到任务'}), 404
    return jsonify(job.to_dict())

@socketio.on('connect')
def handle_connect():
    # 处理新的WebSocket连接
    client_id = request.sid
    print(f'新节点连接: {client_id}')
    
    # 存储节点信息
    nodes[client_id] = {
        'files': []
    }

@socketio.on('disconnect')
def handle_disconnect():
    # 处理连接断开
    client_id = request.sid
    print(f'节点断开连接: {client_id}')
    
    # 从节点列表中删除
    if client_id in nodes:
        del nodes[client_id]
        # 广播文件列表更新给所有节点
        socketio.emit('file-list-updated')

@socketio.on('share-files')
def handle_share_files(files):
    # 处理节点共享文件列表
    client_id = request.sid
    if client_id in nodes:
        nodes[client_id]['files'] = files
        print(f'节点 {client_id} 共享了 {len(files)} 个文件')
        # 广播文件列表更新给所有节点
        socketio.emit('file-list-updated')

@socketio.on('get-file-lists')
def handle_get_file_lists():
    # 处理获取文件列表请求
    client_id = request.sid
    file_lists = []
    
    for node_id, node_info in nodes.items():
        file_lists.append({
            'nodeId': node_id,
            'files': node_info['files']
        })
    
    # 发送文件列表给请求的节点
    socketio.emit('file-lists', file_lists, to=client_id)

@socketio.on('request-download')
def handle_request_download(data):
    # 处理下载请求
    client_id = request.sid
    target_node_id = data['targetNodeId']
    file_id = data['fileId']
    
    # 检查目标节点是否存在
    if target_node_id in nodes:
        # 找到请求的文件
        target_files = nodes[target_node_id]['files']
        file = next((f for f in target_files if f['id'] == file_id), None)
        
        if file:
            # 通知目标节点有下载请求
            socketio.emit('download-request', {
                'fromNodeId': client_id,
                'fileId': file_id
            }, to=target_node_id)
            
            # 告诉请求节点目标节点的信息，开始建立P2P连接
            socketio.emit('start-peer-connection', {
                'targetNodeId': target_node_id
            }, to=client_id)
        else:
            socketio.emit('error', '请求的文件不存在', to=client_id)
    else:
        socketio.emit('error', '目标节点不在线', to=client_id)

@socketio.on('signal')
def handle_signal(data):
    # 处理WebRTC信令消息
    client_id = request.sid
    target_node_id = data['targetNodeId']
    signal_data = data['signal']
    
    # 检查目标节点是否存在
    if target_node_id in nodes:
        # 转发信令消息给目标节点
        socketio.emit('signal', {
            'fromNodeId': client_id,
            'signal': signal_data
        }, to=target_node_id)
    else:
        socketio.emit('error', '目标节点不在线', to=client_id)


@socketio.on('ai-realtime-start')
def handle_ai_realtime_start(data):
    languages = parse_list_field(data.get('languages')) or ['zh']
    mime_type = data.get('mimeType', 'audio/webm')
    session_id = data.get('sessionId') or uuid.uuid4().hex
    file_path = os.path.join(UPLOAD_DIR, f"{session_id}.webm")
    REALTIME_SESSIONS[session_id] = {
        'file_path': file_path,
        'languages': languages,
        'mime_type': mime_type,
        'descriptor': detect_media_type(f'{session_id}.webm', mime_type),
        'created_at': time.time(),
        'client_id': request.sid,
    }
    socketio.emit('ai-realtime-started', {'sessionId': session_id, 'languages': languages}, to=request.sid)


@socketio.on('ai-realtime-chunk')
def handle_ai_realtime_chunk(data):
    session_id = data.get('sessionId')
    chunk = data.get('chunk')
    if not session_id or not chunk:
        return
    session = REALTIME_SESSIONS.get(session_id)
    if not session:
        return

    try:
        with open(session['file_path'], 'ab') as sink:
            sink.write(base64.b64decode(chunk))
        session['descriptor'].size_bytes = os.path.getsize(session['file_path'])
    except Exception as exc:  # pragma: no cover - IO safety
        socketio.emit('ai-realtime-error', {'sessionId': session_id, 'error': str(exc)}, to=request.sid)
        return

    client = get_ai_client()
    transcripts = {}
    try:
        if client.is_configured:
            result = client.generate_subtitles(session['file_path'], session['descriptor'], session['languages'])
            subtitles = result.get('subtitles', {})
            transcripts = {lang: extract_latest_line_from_srt(text) for lang, text in subtitles.items()}
        else:
            transcripts = {lang: '请配置DEEPSEEK_API_KEY以启用实时字幕' for lang in session['languages']}
    except DeepSeekError as exc:
        transcripts = {lang: f'实时字幕失败: {exc}' for lang in session['languages']}

    socketio.emit('ai-realtime-transcript', {
        'sessionId': session_id,
        'timestamp': time.time(),
        'transcript': transcripts
    }, to=request.sid)


@socketio.on('ai-realtime-stop')
def handle_ai_realtime_stop(data):
    session_id = data.get('sessionId')
    session = REALTIME_SESSIONS.pop(session_id, None)
    if not session:
        return

    client = get_ai_client()
    final_payload = {'sessionId': session_id, 'completed': True}
    if client.is_configured:
        try:
            result = client.generate_subtitles(session['file_path'], session['descriptor'], session['languages'])
            final_payload['subtitles'] = result.get('subtitles')
        except DeepSeekError as exc:
            final_payload['error'] = str(exc)
    socketio.emit('ai-realtime-finished', final_payload, to=request.sid)

import socket
import subprocess
import re
import urllib.request
import json

if __name__ == '__main__':
    # 获取端口号，默认为3000
    port = int(os.environ.get('PORT', 3000))
    
    # 显示可访问的链接
    print('服务器已启动，可通过以下链接访问:')
    print(f'本地访问: http://localhost:{port}')
    
    # 尝试获取局域网IP地址
    try:
        # 使用Windows命令行工具获取IP地址（避免Unicode问题）
        result = subprocess.run(['ipconfig'], capture_output=True, text=True, shell=True)
        output = result.stdout
        
        # 使用正则表达式提取IPv4地址
        ipv4_pattern = r'IPv4地址.*?: (.*?)\r'
        ip_addresses = re.findall(ipv4_pattern, output)
        
        # 过滤出非localhost的IP地址
        external_ips = [ip for ip in ip_addresses if not ip.startswith('127.')]
        
        if external_ips:
            print('局域网访问链接:')
            for ip in external_ips:
                print(f'  http://{ip}:{port}')
        else:
            print('提示: 无法获取局域网IP地址，您可以手动运行ipconfig命令查看')
    except Exception as e:
        print(f'获取局域网IP地址时出错: {str(e)}')
        print('您可以手动运行ipconfig命令查看本机IP地址')
    
    print(f'\n提示: 服务器正在 http://localhost:{port} 上运行')
    
    # 启动服务器
    socketio.run(app, host='0.0.0.0', port=port, debug=True)