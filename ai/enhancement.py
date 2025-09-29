import base64
import os
import tempfile
from typing import Dict

import cv2  # type: ignore
import numpy as np
from pydub import AudioSegment

from .media_utils import MediaDescriptor, human_file_size


def encode_file(file_path: str) -> str:
    with open(file_path, "rb") as fh:
        return base64.b64encode(fh.read()).decode("utf-8")


def enhance_image(file_path: str, descriptor: MediaDescriptor) -> Dict[str, str]:
    image = cv2.imread(file_path, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("无法读取图像文件")

    enhanced = cv2.detailEnhance(image, sigma_s=12, sigma_r=0.15)
    denoised = cv2.fastNlMeansDenoisingColored(enhanced, None, 10, 10, 7, 21)
    upscaled = cv2.resize(denoised, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)

    temp_dir = tempfile.mkdtemp(prefix="ai-enhance-")
    output_path = os.path.join(temp_dir, f"enhanced{descriptor.extension or '.png'}")
    cv2.imwrite(output_path, upscaled)

    report = [
        "已执行图像细节增强(detailEnhance)与颜色去噪(NLMeans)",
        "进行1.5倍超分辨率放大并保持平滑细节",
    ]

    return {
        "summary": "；".join(report),
        "outputPath": output_path,
        "base64": encode_file(output_path),
        "outputSize": human_file_size(os.path.getsize(output_path)),
        "mimeType": descriptor.mime_type or "image/png",
        "fileName": os.path.basename(output_path),
    }


def enhance_video(file_path: str, descriptor: MediaDescriptor) -> Dict[str, str]:
    capture = cv2.VideoCapture(file_path)
    if not capture.isOpened():
        raise ValueError("无法打开视频文件")

    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))

    temp_dir = tempfile.mkdtemp(prefix="ai-enhance-")
    output_path = os.path.join(temp_dir, "enhanced.mp4")
    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )

    prev_frame = None
    frame_count = 0
    while True:
        ret, frame = capture.read()
        if not ret:
            break
        frame_count += 1
        denoised = cv2.fastNlMeansDenoisingColored(frame, None, 5, 5, 7, 21)
        sharpen_kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
        sharpened = cv2.filter2D(denoised, -1, sharpen_kernel)
        if prev_frame is None:
            stabilized = sharpened
        else:
            stabilized = cv2.addWeighted(prev_frame, 0.1, sharpened, 0.9, 0)
        writer.write(stabilized)
        prev_frame = stabilized

    capture.release()
    writer.release()

    report = [
        "执行非局部均值去噪，降低视频噪点",
        "应用锐化卷积增强细节",
        "通过逐帧Weighted平滑缓解抖动",
    ]

    return {
        "summary": "；".join(report),
        "outputPath": output_path,
        "base64": encode_file(output_path),
        "outputSize": human_file_size(os.path.getsize(output_path)),
        "frames": frame_count,
        "fps": fps,
        "resolution": f"{width}x{height}",
        "mimeType": "video/mp4",
        "fileName": os.path.basename(output_path),
    }


def enhance_audio(file_path: str, descriptor: MediaDescriptor) -> Dict[str, str]:
    audio = AudioSegment.from_file(file_path)
    normalized = audio.normalize(headroom=1.0)
    denoised = normalized.low_pass_filter(16000).high_pass_filter(80)

    temp_dir = tempfile.mkdtemp(prefix="ai-enhance-")
    output_ext = descriptor.extension or ".wav"
    output_path = os.path.join(temp_dir, f"enhanced{output_ext}")
    denoised.export(output_path, format=output_ext.lstrip("."))

    report = [
        "执行响度归一化，拉平动态范围",
        "使用双向滤波降低高频噪声与低频嗡鸣",
    ]

    return {
        "summary": "；".join(report),
        "outputPath": output_path,
        "base64": encode_file(output_path),
        "outputSize": human_file_size(os.path.getsize(output_path)),
        "duration": f"{len(denoised) / 1000:.2f} 秒",
        "mimeType": descriptor.mime_type or "audio/wav",
        "fileName": os.path.basename(output_path),
    }


def enhance_media(file_path: str, descriptor: MediaDescriptor) -> Dict[str, str]:
    if descriptor.media_type == "image":
        return enhance_image(file_path, descriptor)
    if descriptor.media_type == "video":
        return enhance_video(file_path, descriptor)
    if descriptor.media_type == "audio":
        return enhance_audio(file_path, descriptor)
    raise ValueError("暂不支持的媒体类型")
