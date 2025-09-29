const SUPPORTED_MEDIA = [
    {
        category: 'audio',
        label: '音频',
        match: (type) => type.startsWith('audio/'),
        fallbackExts: ['mp3', 'wav', 'ogg', 'flac', 'm4a']
    },
    {
        category: 'video',
        label: '视频',
        match: (type) => type.startsWith('video/'),
        fallbackExts: ['mp4', 'mov', 'avi', 'mkv', 'webm']
    },
    {
        category: 'image',
        label: '图片',
        match: (type) => type.startsWith('image/'),
        fallbackExts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']
    }
];

const MIME_FALLBACKS = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp'
};

const DEFAULT_EXTENSION_BY_CATEGORY = {
    audio: 'mp3',
    video: 'mp4',
    image: 'jpg'
};

const MIME_TO_EXTENSION = Object.entries(MIME_FALLBACKS).reduce((acc, [ext, mime]) => {
    if (!acc[mime]) {
        acc[mime] = ext;
    }
    return acc;
}, {});

const TRANSFER_CONFIG = {
    chunkSize: 256 * 1024, // 256KB
    maxBufferedAmount: 8 * 256 * 1024,
    resumeThreshold: 3 * 256 * 1024
};

// 全局变量
let socket = null;
let peerConnections = new Map();
let myFiles = [];
let networkFiles = [];
let currentTab = 'my-files';

// DOM元素
const fileInput = document.getElementById('file-input');
const myFilesList = document.getElementById('my-files-list');
const networkFilesList = document.getElementById('network-files-list');
const statusLog = document.getElementById('status-log');
const peerStatus = document.getElementById('peer-status');
const aiAnalyzeForm = document.getElementById('ai-analyze-form');
const aiFileInput = document.getElementById('ai-file-input');
const aiSelectedFile = document.getElementById('ai-selected-file');
const aiAnalysisResults = document.getElementById('ai-analysis-results');
const aiJobList = document.getElementById('ai-job-list');
const aiJobResults = document.getElementById('ai-job-results');
const startRealtimeBtn = document.getElementById('start-realtime-btn');
const stopRealtimeBtn = document.getElementById('stop-realtime-btn');
const realtimeTranscriptEl = document.getElementById('realtime-transcript');
const realtimeLanguageSelect = document.getElementById('realtime-language-select');
const aiFloatingToggle = document.getElementById('ai-floating-toggle');
const aiOverlay = document.getElementById('ai-overlay');
const aiPanel = document.getElementById('ai-panel');
const aiPanelClose = document.getElementById('ai-panel-close');

const aiJobPolling = new Map();
let realtimeSessionId = null;
let mediaRecorder = null;
let realtimeStream = null;

function determineCategory(file) {
    const mimeType = file.type || '';
    const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';

    for (const media of SUPPORTED_MEDIA) {
        if (media.match(mimeType)) {
            return media.category;
        }
        if (extension && media.fallbackExts.includes(extension)) {
            return media.category;
        }
    }
    return null;
}

function determineCategoryFromMetadata(fileMeta) {
    if (!fileMeta) {
        return null;
    }
    const mimeType = fileMeta.type || '';
    const extension = fileMeta.name && fileMeta.name.includes('.')
        ? fileMeta.name.split('.').pop().toLowerCase()
        : '';

    for (const media of SUPPORTED_MEDIA) {
        if (media.match(mimeType)) {
            return media.category;
        }
        if (extension && media.fallbackExts.includes(extension)) {
            return media.category;
        }
    }
    return null;
}

function getCategoryLabel(category) {
    const media = SUPPORTED_MEDIA.find(item => item.category === category);
    return media ? media.label : '未知类型';
}

function isSupportedCategory(category) {
    return SUPPORTED_MEDIA.some(media => media.category === category);
}

function getCategoryClass(category) {
    if (!category || !isSupportedCategory(category)) {
        return 'file-tag-unknown';
    }
    return `file-tag-${category}`;
}

function resolveFileCategory(fileMeta) {
    if (fileMeta?.category && isSupportedCategory(fileMeta.category)) {
        return fileMeta.category;
    }
    return determineCategoryFromMetadata(fileMeta);
}

// 初始化应用
function initApp() {
    // 连接WebSocket服务器
    connectToServer();
    
    // 设置文件上传事件监听
    fileInput.addEventListener('change', handleFileUpload);
    if (aiFileInput) {
        aiFileInput.addEventListener('change', handleAIMediaSelection);
    }
    if (aiAnalyzeForm) {
        aiAnalyzeForm.addEventListener('submit', handleAIAnalyzeSubmit);
    }
    if (startRealtimeBtn) {
        startRealtimeBtn.addEventListener('click', startRealtimeSubtitles);
    }
    if (stopRealtimeBtn) {
        stopRealtimeBtn.addEventListener('click', stopRealtimeSubtitles);
    }
    if (aiFloatingToggle && aiPanel) {
        aiFloatingToggle.addEventListener('click', () => {
            if (aiPanel.classList.contains('active')) {
                closeAIPanel();
            } else {
                openAIPanel();
            }
        });
    }
    if (aiPanelClose) {
        aiPanelClose.addEventListener('click', () => closeAIPanel());
    }
    if (aiOverlay) {
        aiOverlay.addEventListener('click', () => closeAIPanel());
    }
    document.addEventListener('keydown', handlePanelKeydown);
    
    // 定期刷新文件列表
    setInterval(refreshNetworkFiles, 5000);

    // 预加载AI配置
    fetchAIConfig();
}

// 连接到服务器
function connectToServer() {
    try {
        // 连接WebSocket服务器
        // 注意：Python版本的Flask-SocketIO需要使用正确的客户端库
        socket = io();
        
        // 更新连接状态
        updatePeerStatus(true);
        log('已连接到服务器');
        
        // 监听服务器事件
        socket.on('connect', () => {
            log('WebSocket连接已建立');
            updatePeerStatus(true);
            // 连接后立即刷新文件列表
            refreshNetworkFiles();
        });
        
        socket.on('disconnect', () => {
            log('WebSocket连接已断开');
            updatePeerStatus(false);
        });
        
        socket.on('error', (error) => {
            log(`错误: ${error}`);
        });
        
        socket.on('file-lists', (fileLists) => {
            handleFileLists(fileLists);
        });
        
        socket.on('file-list-updated', () => {
            refreshNetworkFiles();
        });
        
        socket.on('start-peer-connection', (data) => {
            const { targetNodeId } = data;
            startPeerConnection(targetNodeId);
        });
        
        socket.on('download-request', (data) => {
            const { fromNodeId, fileId } = data;
            handleDownloadRequest(fromNodeId, fileId);
        });
        
        socket.on('signal', async (data) => {
            const { fromNodeId, signal } = data;
            await handleSignal(fromNodeId, signal);
        });

        socket.on('ai-realtime-started', (data) => {
            realtimeSessionId = data.sessionId;
            if (realtimeTranscriptEl) {
                realtimeTranscriptEl.textContent = '实时字幕已启动，正在聆听...';
            }
        });

        socket.on('ai-realtime-transcript', (data) => {
            if (!realtimeTranscriptEl || data.sessionId !== realtimeSessionId) {
                return;
            }
            const transcript = data.transcript || {};
            const lines = Object.entries(transcript).map(([lang, text]) => `${lang}: ${text || ''}`);
            realtimeTranscriptEl.textContent = lines.join('\n') || '暂无字幕输出';
        });

        socket.on('ai-realtime-finished', (data) => {
            if (data.sessionId !== realtimeSessionId) {
                return;
            }
            if (realtimeTranscriptEl) {
                realtimeTranscriptEl.textContent = '实时字幕已结束';
            }
            if (data.subtitles) {
                handleJobResult('subtitles', { subtitles: data.subtitles });
            }
            resetRealtimeState();
        });

        socket.on('ai-realtime-error', (data) => {
            if (data.sessionId && data.sessionId !== realtimeSessionId) {
                return;
            }
            renderAIMessage(`实时字幕错误: ${data.error}`, 'error');
            resetRealtimeState();
        });
    } catch (error) {
        log(`连接服务器失败: ${error.message}`);
        updatePeerStatus(false);
    }
}

// 处理文件上传
function handleFileUpload(event) {
    const files = event.target.files;
    
    if (files.length === 0) {
        return;
    }
    
    // 处理每个上传的文件
    Array.from(files).forEach(file => {
        const category = determineCategory(file);
        if (!category) {
            log(`跳过不支持的文件类型: ${file.name} (${file.type || '未知类型'})`);
            return;
        }

        const fileInfo = {
            id: generateUniqueId(),
            name: file.name,
            size: formatFileSize(file.size),
            sizeBytes: file.size,
            type: file.type,
            category,
            file: file // 保存实际文件引用
        };
        
        myFiles.push(fileInfo);
        log(`已添加${getCategoryLabel(category)}文件: ${file.name}`);
    });
    
    // 更新我的文件列表显示
    renderMyFiles();
    
    // 将文件列表共享到服务器
    shareFiles();
    
    // 清空文件输入，允许重复选择相同的文件
    fileInput.value = '';
}

function handleAIMediaSelection(event) {
    const file = event.target.files && event.target.files[0];
    if (!aiSelectedFile) {
        return;
    }
    if (!file) {
        aiSelectedFile.textContent = '未选择文件';
        return;
    }
    aiSelectedFile.textContent = `${file.name} · ${formatFileSize(file.size)}`;
}

async function handleAIAnalyzeSubmit(event) {
    event.preventDefault();
    if (!aiFileInput || !aiFileInput.files || aiFileInput.files.length === 0) {
        renderAIMessage('请先选择需要分析的媒体文件。', 'warning');
        return;
    }

    const submitBtn = aiAnalyzeForm.querySelector('button[type="submit"]');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '分析中...';
    }
    renderAIMessage('正在调用 DeepSeek 分析，请稍候...', 'info');

    const formData = new FormData();
    formData.append('file', aiFileInput.files[0]);

    if (aiJobResults) {
        aiJobResults.innerHTML = '';
    }
    if (aiJobList) {
        aiJobList.innerHTML = '';
    }
    aiJobPolling.forEach(interval => clearInterval(interval));
    aiJobPolling.clear();

    const taskInputs = Array.from(aiAnalyzeForm.querySelectorAll('input[name="tasks"]:checked'));
    if (taskInputs.length === 0) {
        formData.append('tasks', 'auto_tag');
        formData.append('tasks', 'moderation');
    } else {
        taskInputs.forEach(input => formData.append('tasks', input.value));
    }

    const languageSelect = document.getElementById('ai-languages');
    const languages = languageSelect ? Array.from(languageSelect.selectedOptions).map(opt => opt.value) : ['zh', 'en'];
    languages.forEach(lang => formData.append('languages', lang));

    try {
        const response = await fetch('/api/ai/analyze', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'AI 分析请求失败');
        }
        renderAIAnalysis(data);
        renderAIJobs(data.jobs || []);
        (data.jobs || []).forEach(job => startJobPolling(job));
    } catch (error) {
        renderAIMessage(`AI 分析失败: ${error.message}`, 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '提交 AI 分析';
        }
    }
}

function renderAIMessage(message, type = 'info') {
    if (!aiAnalysisResults) {
        return;
    }
    const color = type === 'error' ? '#c53030' : type === 'warning' ? '#b7791f' : '#2c5282';
    aiAnalysisResults.style.display = 'block';
    aiAnalysisResults.innerHTML = `<h3 style="color:${color};">${message}</h3>`;
}

async function fetchAIConfig() {
    if (!window.fetch) {
        return;
    }
    try {
        const response = await fetch('/api/ai/config');
        const data = await response.json();
        if (!data.configured) {
            renderAIMessage('未检测到 DeepSeek API KEY，系统将使用本地智能示例模式。', 'warning');
        }
        window.deepSeekConfig = data;
    } catch (error) {
        log(`获取AI配置失败: ${error.message}`);
    }
}

function openAIPanel() {
    if (!aiPanel) {
        return;
    }
    aiPanel.classList.add('active');
    if (aiOverlay) {
        aiOverlay.classList.add('active');
    }
    if (aiFloatingToggle) {
        aiFloatingToggle.setAttribute('aria-expanded', 'true');
    }
    aiPanel.setAttribute('aria-hidden', 'false');
    const focusTarget = aiPanel.querySelector('button, input, select, textarea');
    if (focusTarget) {
        setTimeout(() => focusTarget.focus(), 120);
    }
}

function closeAIPanel() {
    if (!aiPanel) {
        return;
    }
    aiPanel.classList.remove('active');
    if (aiOverlay) {
        aiOverlay.classList.remove('active');
    }
    if (aiFloatingToggle) {
        aiFloatingToggle.setAttribute('aria-expanded', 'false');
        aiFloatingToggle.focus({ preventScroll: true });
    }
    aiPanel.setAttribute('aria-hidden', 'true');
}

function handlePanelKeydown(event) {
    if (event.key === 'Escape' && aiPanel?.classList.contains('active')) {
        closeAIPanel();
    }
}

function renderAIAnalysis(data) {
    if (!aiAnalysisResults) {
        return;
    }
    aiAnalysisResults.style.display = 'block';
    const analysis = data.analysis || {};
    const moderation = data.moderation || {};
    const tags = (analysis.tags || []).map(tag => `<span class="badge">${tag}</span>`).join(' ');
    const recs = (analysis.recommendations || []).map(item => `<li>${item}</li>`).join('');
    const languages = analysis.languages || {};

    const languageBlocks = Object.entries(languages).map(([lang, summary]) => `
        <div>
            <strong>${lang}</strong>
            <p style="margin-top:4px;">${summary}</p>
        </div>
    `).join('');

    aiAnalysisResults.innerHTML = `
        <h3>AI 内容理解结果</h3>
        <p><strong>媒体类型：</strong>${data.mediaType || '未知'}</p>
        <p><strong>智能标签：</strong>${tags || '暂未识别标签'}</p>
        <p><strong>场景识别：</strong>${analysis.scene || '—'}</p>
        <p><strong>情绪识别：</strong>${(analysis.emotions || []).join('、') || '—'}</p>
        ${recs ? `<div style="margin-top:12px;"><strong>推荐应用：</strong><ul>${recs}</ul></div>` : ''}
        ${languageBlocks ? `<div style="margin-top:12px;"><strong>多语言摘要：</strong>${languageBlocks}</div>` : ''}
        ${moderation.level ? `
            <div style="margin-top:16px;">
                <strong>内容审核：</strong>
                <div class="badge">等级：${moderation.level}</div>
                <p style="margin-top:6px;">${moderation.guidance || ''}</p>
                ${(moderation.reasons || []).map(reason => `<div>• ${reason}</div>`).join('')}
            </div>
        ` : ''}
    `;
}

function renderAIJobs(jobs) {
    if (!aiJobList) {
        return;
    }
    if (!jobs.length) {
        aiJobList.innerHTML = '';
        return;
    }
    aiJobList.innerHTML = '';
    jobs.forEach(job => {
        const item = document.createElement('div');
        item.className = 'ai-job-item';
        item.id = `ai-job-${job.jobId}`;
        item.innerHTML = `
            <div>
                <div style="font-weight:600;">${job.label}</div>
                <div style="font-size:0.85rem;color:#4a5568;">类型：${job.type}</div>
            </div>
            <div class="badge" data-status>${job.status}</div>
        `;
        aiJobList.appendChild(item);
    });
}

function updateJobStatus(jobId, status, result, errorMessage) {
    const item = document.getElementById(`ai-job-${jobId}`);
    if (item) {
        const badge = item.querySelector('[data-status]');
        if (badge) {
            badge.textContent = status;
        }
    }
    if (status === 'completed' && result) {
        handleJobResult(result.type, result.payload || result);
    }
    if (status === 'failed') {
        const message = errorMessage || result?.error || '未知错误';
        renderAIMessage(`AI 异步任务失败：${message}`, 'error');
    }
}

function startJobPolling(job) {
    if (!job || aiJobPolling.has(job.jobId)) {
        return;
    }
    const interval = setInterval(async () => {
        try {
            const response = await fetch(`/api/ai/jobs/${job.jobId}`);
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || '任务查询失败');
            }
            updateJobStatus(job.jobId, data.status, data.result, data.error);
            if (data.status === 'completed' || data.status === 'failed') {
                clearInterval(interval);
                aiJobPolling.delete(job.jobId);
            }
        } catch (error) {
            log(`查询AI任务失败: ${error.message}`);
        }
    }, 4000);
    aiJobPolling.set(job.jobId, interval);
}

function handleJobResult(jobType, payload) {
    if (!aiJobResults || !payload) {
        return;
    }
    const card = document.createElement('div');
    card.className = 'ai-result-card';
    if (jobType === 'subtitles') {
        const subtitles = payload.subtitles || {};
        const blocks = Object.entries(subtitles).map(([lang, srt]) => `
            <details style="margin-bottom:12px;" open>
                <summary style="font-weight:600;">${lang} 字幕</summary>
                <pre style="margin-top:8px;white-space:pre-wrap;background:#1a202c;color:#f7fafc;padding:12px;border-radius:8px;">${srt}</pre>
            </details>
        `).join('');
        card.innerHTML = `<h3>字幕生成完成</h3>${blocks}`;
    } else if (jobType === 'enhancement') {
        const mimeType = payload.mimeType || 'application/octet-stream';
        const fileName = payload.fileName || 'enhanced-output';
        const downloadUrl = createDownloadUrlFromBase64(payload.base64, mimeType);
        card.innerHTML = `
            <h3>智能增强完成</h3>
            <p>${payload.summary || ''}</p>
            <p>输出大小：${payload.outputSize || '未知'}</p>
            <a href="${downloadUrl}" download="${fileName}" class="upload-btn" style="display:inline-block;margin-top:12px;">下载增强结果</a>
        `;
    } else {
        card.innerHTML = `<h3>任务完成 (${jobType})</h3><pre>${JSON.stringify(payload, null, 2)}</pre>`;
    }
    aiJobResults.appendChild(card);
}

function createDownloadUrlFromBase64(base64Data, mimeType) {
    const byteCharacters = atob(base64Data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });
    return URL.createObjectURL(blob);
}

async function startRealtimeSubtitles() {
    if (!socket || !socket.connected) {
        renderAIMessage('实时字幕需要先连接到服务器。', 'warning');
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        renderAIMessage('当前浏览器不支持音频捕获，无法启用实时字幕。', 'error');
        return;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        return;
    }

    try {
        realtimeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
        mediaRecorder = new MediaRecorder(realtimeStream, { mimeType });
        mediaRecorder.ondataavailable = async (event) => {
            if (event.data && event.data.size > 0 && realtimeSessionId) {
                const base64Chunk = await blobToBase64(event.data);
                socket.emit('ai-realtime-chunk', {
                    sessionId: realtimeSessionId,
                    chunk: base64Chunk
                });
            }
        };
        mediaRecorder.onstop = () => {
            if (realtimeStream) {
                realtimeStream.getTracks().forEach(track => track.stop());
            }
        };
        mediaRecorder.start(1000);
        const language = realtimeLanguageSelect ? realtimeLanguageSelect.value : 'zh';
        socket.emit('ai-realtime-start', {
            languages: [language],
            mimeType
        });
        if (startRealtimeBtn) {
            startRealtimeBtn.disabled = true;
        }
        if (stopRealtimeBtn) {
            stopRealtimeBtn.disabled = false;
        }
        if (realtimeTranscriptEl) {
            realtimeTranscriptEl.textContent = '正在初始化实时字幕...';
        }
    } catch (error) {
        renderAIMessage(`无法启动实时字幕：${error.message}`, 'error');
        resetRealtimeState();
    }
}

function stopRealtimeSubtitles() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    if (socket && realtimeSessionId) {
        socket.emit('ai-realtime-stop', { sessionId: realtimeSessionId });
    }
    resetRealtimeState();
}

function resetRealtimeState() {
    if (startRealtimeBtn) {
        startRealtimeBtn.disabled = false;
    }
    if (stopRealtimeBtn) {
        stopRealtimeBtn.disabled = true;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    if (realtimeStream) {
        realtimeStream.getTracks().forEach(track => track.stop());
        realtimeStream = null;
    }
    if (realtimeTranscriptEl) {
        realtimeTranscriptEl.textContent = '实时字幕未启动';
    }
    mediaRecorder = null;
    realtimeSessionId = null;
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64data = reader.result.split(',')[1];
            resolve(base64data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// 共享文件列表到服务器
function shareFiles() {
    if (!socket || !socket.connected) {
        log('无法共享文件，未连接到服务器');
        return;
    }
    
    // 准备要发送的文件信息（不包含实际文件数据）
    const fileInfoList = myFiles.map(file => ({
        id: file.id,
        name: file.name,
        size: file.size,
        sizeBytes: file.sizeBytes,
        type: file.type,
        category: file.category
    }));
    
    socket.emit('share-files', fileInfoList);
    log(`已共享 ${fileInfoList.length} 个文件到网络`);
}

// 刷新网络文件列表
function refreshNetworkFiles(emitLog = false) {
    if (!socket || !socket.connected) {
        return;
    }
    
    socket.emit('get-file-lists');
    if (emitLog) {
        log('已请求刷新网络文件列表');
    }
}

function manualRefreshNetworkFiles() {
    if (!socket || !socket.connected) {
        log('无法刷新网络文件，当前未连接到服务器');
        return;
    }
    refreshNetworkFiles(true);
}

// 处理服务器返回的文件列表
function handleFileLists(fileLists) {
    networkFiles = fileLists;
    
    if (currentTab === 'network-files') {
        renderNetworkFiles();
    }
}

// 渲染我的文件列表
function renderMyFiles() {
    myFilesList.innerHTML = '';
    
    if (myFiles.length === 0) {
        myFilesList.innerHTML = '<li>暂无文件，请上传音频、视频或图片文件</li>';
        return;
    }
    
    myFiles.forEach(file => {
        const li = document.createElement('li');
        const category = resolveFileCategory(file);
        li.innerHTML = `
            <div class="file-info">
                <div class="file-name">${file.name}</div>
                <div class="file-meta">
                    <span class="file-tag ${getCategoryClass(category)}">${getCategoryLabel(category)}</span>
	                <div class="file-size">${file.size}</div>
                </div>
            </div>
            <div class="file-actions">
                <button class="download-btn" disabled>本地文件</button>
                <button class="remove-btn" onclick="removeFile('${file.id}')">移除</button>
            </div>
        `;
        myFilesList.appendChild(li);
    });
}

function removeFile(fileId) {
    const fileIndex = myFiles.findIndex(file => file.id === fileId);
    if (fileIndex === -1) {
        log('未找到要移除的文件');
        return;
    }
    const [removedFile] = myFiles.splice(fileIndex, 1);
    renderMyFiles();
    shareFiles();
    log(`已移除文件: ${removedFile.name}`);
}

// 渲染网络文件列表
function renderNetworkFiles() {
    networkFilesList.innerHTML = '';
    
    if (networkFiles.length === 0) {
        networkFilesList.innerHTML = '<li>网络中暂无共享文件</li>';
        return;
    }
    
    let hasFiles = false;
    
    networkFiles.forEach(node => {
        // 跳过自己的文件
        if (node.nodeId === socket?.id) {
            return;
        }
        
        if (node.files && node.files.length > 0) {
            hasFiles = true;
            
            node.files.forEach(file => {
                const li = document.createElement('li');
                const category = resolveFileCategory(file);
                li.innerHTML = `
                    <div class="file-info">
                        <div class="file-name">${file.name}</div>
                        <div class="file-meta">
                            <span class="file-tag ${getCategoryClass(category)}">${getCategoryLabel(category)}</span>
                            <div class="file-size">${file.size}</div>
                        </div>
                    </div>
                    <button class="download-btn" onclick="downloadFile('${node.nodeId}', '${file.id}', '${file.name}')">下载</button>
                `;
                networkFilesList.appendChild(li);
            });
        }
    });
    
    if (!hasFiles) {
        networkFilesList.innerHTML = '<li>网络中暂无其他用户共享的文件</li>';
    }
}

// 下载文件
function downloadFile(nodeId, fileId, fileName) {
    if (!socket || !socket.connected) {
        log('无法下载文件，未连接到服务器');
        return;
    }
    
    log(`请求下载文件: ${fileName} 从节点 ${nodeId}`);
    socket.emit('request-download', {
        targetNodeId: nodeId,
        fileId: fileId
    });
}

// 开始建立P2P连接
async function startPeerConnection(targetNodeId) {
    log(`开始与节点 ${targetNodeId} 建立P2P连接`);
    
    try {
        // 创建RTCPeerConnection
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });
        
        // 存储peer connection
        peerConnections.set(targetNodeId, pc);
        
        // 监听ICE候选
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('signal', {
                    targetNodeId,
                    signal: { type: 'candidate', candidate: event.candidate }
                });
            }
        };
        
        // 监听连接状态变化
        pc.onconnectionstatechange = () => {
            log(`与节点 ${targetNodeId} 的连接状态: ${pc.connectionState}`);
            
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // 清理连接
                cleanupPeerConnection(targetNodeId);
            }
        };
        
        // 创建数据通道
        const dataChannel = pc.createDataChannel('fileTransfer', {
            ordered: true
        });
        
        setupDataChannel(dataChannel, targetNodeId);
        
        // 创建offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        // 发送offer到目标节点
        socket.emit('signal', {
            targetNodeId,
            signal: { type: 'offer', sdp: pc.localDescription }
        });
        
    } catch (error) {
        log(`建立P2P连接失败: ${error.message}`);
        cleanupPeerConnection(targetNodeId);
    }
}

// 处理下载请求
async function handleDownloadRequest(fromNodeId, fileId) {
    log(`收到来自节点 ${fromNodeId} 的下载请求，文件ID: ${fileId}`);
    
    try {
        // 创建RTCPeerConnection
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });
        
        // 存储peer connection
        peerConnections.set(fromNodeId, pc);
        
        // 监听ICE候选
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('signal', {
                    targetNodeId: fromNodeId,
                    signal: { type: 'candidate', candidate: event.candidate }
                });
            }
        };
        
        // 监听连接状态变化
        pc.onconnectionstatechange = () => {
            log(`与节点 ${fromNodeId} 的连接状态: ${pc.connectionState}`);
            
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // 清理连接
                cleanupPeerConnection(fromNodeId);
            }
        };
        
        // 监听数据通道
        pc.ondatachannel = (event) => {
            const dataChannel = event.channel;
            setupDataChannel(dataChannel, fromNodeId, fileId);
        };
        
    } catch (error) {
        log(`处理下载请求失败: ${error.message}`);
        cleanupPeerConnection(fromNodeId);
    }
}

// 处理信令消息
async function handleSignal(fromNodeId, signal) {
    log(`收到来自节点 ${fromNodeId} 的信令消息: ${signal.type}`);
    
    try {
        let pc = peerConnections.get(fromNodeId);
        
        if (!pc && signal.type === 'offer') {
            // 如果是offer，但还没有peer connection，则创建一个
            pc = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            });
            
            peerConnections.set(fromNodeId, pc);
            
            // 设置事件监听
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit('signal', {
                        targetNodeId: fromNodeId,
                        signal: { type: 'candidate', candidate: event.candidate }
                    });
                }
            };
            
            pc.onconnectionstatechange = () => {
                log(`与节点 ${fromNodeId} 的连接状态: ${pc.connectionState}`);
                
                if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                    cleanupPeerConnection(fromNodeId);
                }
            };
            
            pc.ondatachannel = (event) => {
                const dataChannel = event.channel;
                setupDataChannel(dataChannel, fromNodeId);
            };
        }
        
        if (!pc) {
            log(`未找到对应的peer connection`);
            return;
        }
        
        if (signal.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            socket.emit('signal', {
                targetNodeId: fromNodeId,
                signal: { type: 'answer', sdp: pc.localDescription }
            });
        }
        else if (signal.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        }
        else if (signal.type === 'candidate' && signal.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
    } catch (error) {
        log(`处理信令消息失败: ${error.message}`);
    }
}

// 设置数据通道
function setupDataChannel(dataChannel, nodeId, fileId = null) {
    // 存储接收状态的变量，定义在闭包中，确保每个数据通道有独立的状态
    const receiveState = {
        receivedData: [],
        totalSize: 0,
        fileName: '',
        fileType: '',
        category: '',
        chunkCounter: 0,
        lastProgressLog: 0,
        completed: false
    };
    
    // 监听数据通道打开
    dataChannel.onopen = () => {
        log(`与节点 ${nodeId} 的数据通道已打开`);
        
        // 如果是作为发送方（收到下载请求），则开始发送文件
        if (fileId) {
            const file = myFiles.find(f => f.id === fileId);
            if (file) {
                log(`开始发送文件: ${file.name} 到节点 ${nodeId}`);
                sendFileOverDataChannel(dataChannel, file, nodeId);
            } else {
                log(`未找到请求的文件，ID: ${fileId}`);
                dataChannel.close();
            }
        }
    };
    
    // 监听数据接收
    dataChannel.onmessage = (event) => {
        // 记录接收到的数据类型以便调试
        log(`接收到数据，类型: ${typeof event.data}, 是否为Blob: ${event.data instanceof Blob}, 是否为ArrayBuffer: ${event.data instanceof ArrayBuffer}`);
        
        // 检查是否为字符串类型的完成标记
        if (typeof event.data === 'string') {
            try {
                const marker = JSON.parse(event.data);
                if (marker.type === 'metadata') {
                    const metadata = marker.payload || marker;
                    receiveState.fileName = metadata.name || '未知文件名';
                    receiveState.fileType = metadata.type || 'application/octet-stream';
                    receiveState.totalSize = metadata.size || 0;
                    receiveState.category = metadata.category && isSupportedCategory(metadata.category)
                        ? metadata.category
                        : determineCategoryFromMetadata(metadata);
                    const categoryLabel = getCategoryLabel(receiveState.category);
                    log(`开始接收文件: ${receiveState.fileName}, 大小: ${formatFileSize(receiveState.totalSize)}, 类型: ${categoryLabel} / ${receiveState.fileType}`);
                    receiveState.receivedData = [];
                    receiveState.chunkCounter = 0;
                    receiveState.lastProgressLog = 0;
                    return;
                }
                if (marker.type === 'transfer_complete') {
                    log(`接收到文件传输完成标记，文件名: ${marker.fileName}`);
                    // 保存文件名到接收状态中，确保使用原始文件名
                    if (marker.fileName) {
                        receiveState.fileName = marker.fileName;
                        log(`已更新接收状态中的文件名: ${receiveState.fileName}`);
                    }
                    if (marker.category) {
                        receiveState.category = marker.category;
                    }
                    // 立即触发文件处理，确保即使数据大小不匹配也能下载
                    processReceivedFile();
                    return;
                }
            } catch (e) {
                log(`解析字符串数据失败，可能不是JSON格式: ${e.message}`);
            }
        }
        
        // 处理元数据
        if (event.data instanceof Blob) {
            // 检查是否为JSON类型的Blob
            if (event.data.type === 'application/json') {
                event.data.text().then(text => {
                    try {
                        const metadata = JSON.parse(text);
                        receiveState.fileName = metadata.name || '未知文件名';
                        receiveState.fileType = metadata.type || 'application/octet-stream';
                        receiveState.totalSize = metadata.size || 0;
                        receiveState.category = metadata.category && isSupportedCategory(metadata.category)
                            ? metadata.category
                            : determineCategoryFromMetadata(metadata);
                        
                        const categoryLabel = getCategoryLabel(receiveState.category);
                        log(`开始接收文件: ${receiveState.fileName}, 大小: ${formatFileSize(receiveState.totalSize)}, 类型: ${categoryLabel} / ${receiveState.fileType}`);
                        // 重置接收缓冲区
                        receiveState.receivedData = [];
                        receiveState.chunkCounter = 0;
                        receiveState.lastProgressLog = 0;
                    } catch (e) {
                        log(`解析文件元数据失败: ${e.message}`);
                        log(`原始元数据内容: ${text}`);
                    }
                }).catch(err => {
                    log(`读取元数据Blob失败: ${err.message}`);
                });
            } else {
                // 如果是Blob但不是JSON，尝试直接处理
                log(`接收到非JSON类型的Blob，大小: ${event.data.size} bytes`);
                
                // 将Blob转换为ArrayBuffer进行处理
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (e.target.result instanceof ArrayBuffer) {
                        receiveState.receivedData.push(new Uint8Array(e.target.result));
                        
                        // 计算已接收的数据大小
                        const receivedSize = receiveState.receivedData.reduce((sum, chunk) => sum + chunk.length, 0);
                        
                        // 检查是否接收完成
                        if (receiveState.totalSize > 0 && receivedSize >= receiveState.totalSize) {
                            processReceivedFile();
                        }
                    }
                };
                reader.readAsArrayBuffer(event.data);
            }
        }
        // 处理文件数据
        else if (event.data instanceof ArrayBuffer) {
            const chunkSize = event.data.byteLength;
            receiveState.chunkCounter += 1;
            if (receiveState.chunkCounter === 1 || receiveState.chunkCounter % 20 === 0) {
                log(`接收到ArrayBuffer数据块，大小: ${chunkSize} bytes`);
            }
            
            receiveState.receivedData.push(new Uint8Array(event.data));
            
            // 计算已接收的数据大小
            const receivedSize = receiveState.receivedData.reduce((sum, chunk) => sum + chunk.length, 0);
            
            // 显示接收进度
            if (receiveState.totalSize > 0) {
                const progress = Math.round((receivedSize / receiveState.totalSize) * 100);
                if (progress === 100 || progress - receiveState.lastProgressLog >= 5) {
                    log(`文件接收进度: ${progress}% (${formatFileSize(receivedSize)} / ${formatFileSize(receiveState.totalSize)})`);
                    receiveState.lastProgressLog = progress;
                }
            } else {
                if (receiveState.chunkCounter === 1 || receiveState.chunkCounter % 20 === 0) {
                    log(`已接收数据: ${formatFileSize(receivedSize)}`);
                }
            }
            
            // 检查是否接收完成
            if (receiveState.totalSize > 0 && receivedSize >= receiveState.totalSize) {
                processReceivedFile();
            }
        }
        // 处理其他类型的数据
        else {
            log(`接收到未知类型的数据: ${typeof event.data}`);
        }
    };
    
    // 处理接收完成的文件
    function processReceivedFile() {
        if (receiveState.completed) {
            log('检测到重复的文件完成通知，已忽略');
            return;
        }
        receiveState.completed = true;
        log(`文件 ${receiveState.fileName} 接收完成，总共接收到 ${receiveState.receivedData.length} 个数据块`);
        
        let combinedArray;
        let receivedSize = 0;
        
        try {
            // 计算总大小
            receivedSize = receiveState.receivedData.reduce((sum, chunk) => sum + chunk.length, 0);
            log(`接收到的总字节数: ${receivedSize}，预期字节数: ${receiveState.totalSize}`);
            
            // 合并数据
            combinedArray = new Uint8Array(receivedSize);
            let offset = 0;
            receiveState.receivedData.forEach((chunk, index) => {
                log(`合并数据块 ${index + 1}/${receiveState.receivedData.length}，大小: ${chunk.length} bytes，偏移量: ${offset}`);
                combinedArray.set(chunk, offset);
                offset += chunk.length;
            });
        } catch (e) {
            log(`数据合并过程中出错: ${e.message}`);
            // 即使合并失败，也尝试创建一个基本的Blob对象
            combinedArray = new Uint8Array(0);
            log(`创建空数据Blob对象尝试下载`);
        }
        
        let fileType = receiveState.fileType;
        let category = receiveState.category && isSupportedCategory(receiveState.category)
            ? receiveState.category
            : null;

        const fallbackMeta = {
            name: receiveState.fileName,
            type: fileType
        };
        if (!category) {
            category = determineCategoryFromMetadata(fallbackMeta);
        }

        log(`原始文件类型: ${fileType || '未知'}`);

        let validFileName = receiveState.fileName || '未知文件';
        const hasExtension = validFileName.includes('.');
        let extension = hasExtension ? validFileName.split('.').pop().toLowerCase() : '';

        if (!extension && fileType && fileType in MIME_TO_EXTENSION) {
            extension = MIME_TO_EXTENSION[fileType];
            validFileName = `${validFileName}.${extension}`;
        }

        if (extension) {
            const fallbackMime = MIME_FALLBACKS[extension];
            if (!fileType && fallbackMime) {
                fileType = fallbackMime;
            }
            if (!category) {
                category = determineCategoryFromMetadata({ name: validFileName, type: fileType || fallbackMime || '' });
            }
        } else {
            const defaultExt = DEFAULT_EXTENSION_BY_CATEGORY[category] || 'bin';
            extension = defaultExt;
            validFileName = `${validFileName}.${extension}`;
            if (!fileType && MIME_FALLBACKS[extension]) {
                fileType = MIME_FALLBACKS[extension];
            }
        }

        if (!fileType) {
            fileType = 'application/octet-stream';
        }

        if (!category) {
            category = determineCategoryFromMetadata({ name: validFileName, type: fileType });
        }

    receiveState.category = category;
    const categoryLabel = getCategoryLabel(category);

        const blob = new Blob([combinedArray], { type: fileType });
        log(`创建Blob对象，大小: ${blob.size} bytes，类型: ${fileType}`);
        log(`数据完整性检查: 合并后大小 ${combinedArray.length} bytes, Blob大小 ${blob.size} bytes`);
        log(`最终文件名: ${validFileName}，类别: ${categoryLabel}`);
        
        const url = URL.createObjectURL(blob);
        log(`已创建Object URL: ${url.substring(0, 50)}...`);
        
        // 创建下载链接并触发下载
        const a = document.createElement('a');
        a.href = url;
        a.download = validFileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        
        // 多重触发下载机制
        try {
            // 方法1: 标准click()方法
            a.click();
            log(`已触发标准click()方法`);
        } catch (e) {
            log(`标准click()触发失败: ${e.message}`);
            try {
                // 方法2: 鼠标事件触发
                const clickEvent = new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                });
                a.dispatchEvent(clickEvent);
                log(`已触发MouseEvent点击事件`);
            } catch (e2) {
                log(`MouseEvent触发失败: ${e2.message}`);
                try {
                    // 方法3: 直接打开URL
                    window.open(url, '_blank');
                    log(`已尝试通过新窗口打开文件`);
                } catch (e3) {
                    log(`所有下载方法均失败: ${e3.message}`);
                    showNotification(`下载失败，请尝试刷新页面后重试`);
                }
            }
        }
        
        // 显示下载提示
    showNotification(`文件下载已开始 (${categoryLabel}): ${validFileName}`);
        
        // 增加延迟时间到5秒，确保大型音频文件有足够时间下载
        setTimeout(() => {
            try {
                if (document.body.contains(a)) {
                    document.body.removeChild(a);
                }
                // 保留URL更长时间，确保下载完成
                setTimeout(() => {
                    try {
                        URL.revokeObjectURL(url);
                        log(`已释放Object URL资源`);
                    } catch (e) {
                        log(`释放URL资源时出错: ${e.message}`);
                    }
                }, 10000); // 10秒后再释放URL
                log(`已移除下载链接元素`);
            } catch (e) {
                log(`清理DOM元素时出错: ${e.message}`);
            }
            
            // 延迟关闭数据通道
            setTimeout(() => {
                try {
                    dataChannel.close();
                    cleanupPeerConnection(nodeId);
                } catch (e) {
                    log(`关闭数据通道时出错: ${e.message}`);
                }
            }, 2000);
        }, 5000); // 5秒后再开始清理资源
    };
    
    // 显示通知提示
    function showNotification(message) {
        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.position = 'fixed';
        notification.style.top = '20px';
        notification.style.right = '20px';
        notification.style.padding = '12px 20px';
        notification.style.backgroundColor = '#4CAF50';
        notification.style.color = 'white';
        notification.style.borderRadius = '4px';
        notification.style.zIndex = '10000';
        notification.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transition = 'opacity 0.5s';
            setTimeout(() => {
                if (document.body.contains(notification)) {
                    document.body.removeChild(notification);
                }
            }, 500);
        }, 3000);
    };
    
    // 监听数据通道关闭
    dataChannel.onclose = () => {
        log(`与节点 ${nodeId} 的数据通道已关闭`);
    };
    
    // 监听错误
    dataChannel.onerror = (error) => {
        log(`数据通道错误: ${error}`);
    };
}

// 通过数据通道发送文件
function sendFileOverDataChannel(dataChannel, file, targetNodeId) {
    try {
        log(`开始准备发送文件: ${file.name}, 大小: ${formatFileSize(file.sizeBytes)}, 类型: ${file.type || '未知'}`);

        const metadataMessage = JSON.stringify({
            type: 'metadata',
            payload: {
                name: file.name,
                type: file.type,
                size: file.sizeBytes,
                category: file.category
            }
        });

        log(`准备发送元数据: ${metadataMessage}`);

        const sendMetadata = () => {
            try {
                dataChannel.send(metadataMessage);
                log(`元数据已发送，长度: ${metadataMessage.length} chars`);
            } catch (error) {
                log(`发送元数据失败: ${error.message}`);
            }
        };

        const { chunkSize, maxBufferedAmount, resumeThreshold } = TRANSFER_CONFIG;
        let offset = 0;
        let sentChunks = 0;
        let isPaused = false;
        let isReading = false;
        let hasFinished = false;
        const totalChunks = Math.max(1, Math.ceil(file.sizeBytes / chunkSize));
        let lastLoggedProgress = -5;
        const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        const startTime = now();

        dataChannel.bufferedAmountLowThreshold = resumeThreshold;

        const finishTransfer = () => {
            if (hasFinished) {
                return;
            }
            hasFinished = true;
            const elapsedMs = Math.max(1, now() - startTime);
            const throughput = file.sizeBytes ? file.sizeBytes / (elapsedMs / 1000) : 0;

            try {
                const completeMarker = JSON.stringify({
                    type: 'transfer_complete',
                    fileName: file.name,
                    category: file.category
                });
                dataChannel.send(completeMarker);
                log('已发送文件传输完成标记');
            } catch (e) {
                log(`发送完成标记失败: ${e.message}`);
            }

            log(`文件 ${file.name} 发送完成，用时 ${(elapsedMs / 1000).toFixed(2)} 秒，平均速率 ${formatTransferRate(throughput)}`);

            setTimeout(() => {
                try {
                    if (dataChannel.readyState !== 'closed') {
                        dataChannel.close();
                    }
                } catch (e) {
                    log(`关闭数据通道时出错: ${e.message}`);
                }
                if (targetNodeId) {
                    cleanupPeerConnection(targetNodeId);
                }
            }, 2000);
        };

        const attemptFinish = () => {
            if (hasFinished) {
                return;
            }
            if (dataChannel.bufferedAmount > resumeThreshold) {
                setTimeout(attemptFinish, 100);
                return;
            }
            finishTransfer();
        };

        const logProgress = () => {
            const progress = Math.round((sentChunks / totalChunks) * 100);
            if (progress === 100 || progress - lastLoggedProgress >= 5) {
                log(`文件发送进度: ${progress}% (${sentChunks}/${totalChunks} 块)`);
                lastLoggedProgress = progress;
            }
        };

        const reader = new FileReader();

        reader.onload = (event) => {
            if (event.target.readyState !== FileReader.DONE) {
                return;
            }
            isReading = false;

            if (dataChannel.readyState !== 'open') {
                log(`数据通道未打开，无法发送数据块，状态: ${dataChannel.readyState}`);
                return;
            }

            const chunkData = event.target.result;

            try {
                dataChannel.send(chunkData);
                sentChunks += 1;
                if (sentChunks === 1 || sentChunks % 20 === 0) {
                    log(`已发送数据块 ${sentChunks}/${totalChunks}，大小: ${chunkData.byteLength} bytes`);
                }
                logProgress();

                if (offset >= file.sizeBytes) {
                    attemptFinish();
                } else if (dataChannel.bufferedAmount > maxBufferedAmount) {
                    if (!isPaused) {
                        isPaused = true;
                        log(`数据通道缓冲区接近上限，暂停发送... (${formatFileSize(dataChannel.bufferedAmount)})`);
                    }
                } else {
                    readNextChunk();
                }
            } catch (error) {
                log(`发送数据块失败: ${error.message}`);
            }
        };

        reader.onerror = (error) => {
            isReading = false;
            log(`读取文件失败: ${error}`);
            dataChannel.close();
            if (targetNodeId) {
                cleanupPeerConnection(targetNodeId);
            }
        };

        reader.onabort = () => {
            isReading = false;
            log('文件读取被中止');
            dataChannel.close();
            if (targetNodeId) {
                cleanupPeerConnection(targetNodeId);
            }
        };

        const readNextChunk = () => {
            if (isPaused || isReading || offset >= file.sizeBytes) {
                if (!isPaused && offset >= file.sizeBytes) {
                    attemptFinish();
                }
                return;
            }
            const chunkEnd = Math.min(offset + chunkSize, file.sizeBytes);
            const chunk = file.file.slice(offset, chunkEnd);
            isReading = true;
            reader.readAsArrayBuffer(chunk);
            offset = chunkEnd;
        };

        const handleBufferedAmountLow = () => {
            if (isPaused) {
                isPaused = false;
                log('数据通道缓冲区回落，继续发送');
                readNextChunk();
            } else if (!isReading && offset < file.sizeBytes) {
                readNextChunk();
            }
        };

        dataChannel.addEventListener('bufferedamountlow', handleBufferedAmountLow);
        dataChannel.onbufferedamountlow = handleBufferedAmountLow;

        const beginSending = () => {
            if (file.sizeBytes === 0) {
                attemptFinish();
            } else {
                readNextChunk();
            }
        };

        if (dataChannel.readyState === 'open') {
            log('数据通道已打开，准备发送文件数据');
            sendMetadata();
            beginSending();
        } else {
            const handleOpen = () => {
                log('数据通道已打开，准备发送文件数据');
                sendMetadata();
                beginSending();
            };
            dataChannel.addEventListener('open', handleOpen, { once: true });
        }
    } catch (error) {
        log(`发送文件失败: ${error.message}`);
        console.error('发送文件异常:', error);
        dataChannel.close();
        if (targetNodeId) {
            cleanupPeerConnection(targetNodeId);
        }
    }
}

// 清理peer connection
function cleanupPeerConnection(nodeId) {
    const pc = peerConnections.get(nodeId);
    if (pc) {
        // 关闭所有数据通道
        pc.getSenders().forEach(sender => {
            if (sender.track) {
                sender.track.stop();
            }
        });
        
        // 关闭peer connection
        pc.close();
        peerConnections.delete(nodeId);
        log(`已清理与节点 ${nodeId} 的连接资源`);
    }
}

// 切换标签页
function switchTab(tabName) {
    // 更新标签按钮状态
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('onclick').includes(tabName)) {
            btn.classList.add('active');
        }
    });
    
    // 更新标签内容显示
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
        if (content.id === tabName) {
            content.classList.add('active');
        }
    });
    
    // 更新当前标签
    currentTab = tabName;
    
    // 渲染相应的文件列表
    if (tabName === 'my-files') {
        renderMyFiles();
    } else if (tabName === 'network-files') {
        renderNetworkFiles();
    }
}

// 更新连接状态显示
function updatePeerStatus(connected) {
    if (connected) {
        peerStatus.textContent = '已连接到服务器';
        peerStatus.className = 'connected';
    } else {
        peerStatus.textContent = '未连接';
        peerStatus.className = 'disconnected';
    }
}

// 记录日志
function log(message) {
    const now = new Date();
    const timeString = now.toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.textContent = `[${timeString}] ${message}`;
    
    statusLog.appendChild(logEntry);
    
    // 滚动到最新日志
    statusLog.scrollTop = statusLog.scrollHeight;
}

function clearStatusLog() {
    statusLog.innerHTML = '';
    log('操作日志已清空');
}

// 生成唯一ID
function generateUniqueId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTransferRate(bytesPerSecond) {
    if (!bytesPerSecond || !isFinite(bytesPerSecond)) {
        return '0 B/s';
    }
    const k = 1024;
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytesPerSecond) / Math.log(k)));
    const value = bytesPerSecond / Math.pow(k, index);
    return `${value.toFixed(2)} ${units[index]}`;
}

// 页面加载完成后初始化应用
window.addEventListener('load', initApp);