import base64
import mimetypes
import os
from dataclasses import dataclass
from typing import Optional, Tuple

SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}
SUPPORTED_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".m4v"}
SUPPORTED_AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma"}


@dataclass
class MediaDescriptor:
    media_type: str
    mime_type: str
    extension: str
    size_bytes: int


def detect_media_type(filename: str, mime_type: Optional[str] = None) -> MediaDescriptor:
    """Infer high-level media type (image, video, audio) based on filename and optional MIME."""
    guessed_mime, _ = mimetypes.guess_type(filename)
    mime = mime_type or guessed_mime or "application/octet-stream"
    extension = os.path.splitext(filename)[1].lower()

    if extension in SUPPORTED_IMAGE_EXTS or (mime and mime.startswith("image/")):
        media_type = "image"
    elif extension in SUPPORTED_VIDEO_EXTS or (mime and mime.startswith("video/")):
        media_type = "video"
    elif extension in SUPPORTED_AUDIO_EXTS or (mime and mime.startswith("audio/")):
        media_type = "audio"
    else:
        media_type = "unknown"

    return MediaDescriptor(
        media_type=media_type,
        mime_type=mime,
        extension=extension or mimetypes.guess_extension(mime) or "",
        size_bytes=0,
    )


def encode_file_sample(file_path: str, max_bytes: int = 2 * 1024 * 1024) -> Tuple[str, int]:
    """Return a base64-encoded prefix of the file capped at max_bytes, plus total size."""
    file_size = os.path.getsize(file_path)
    with open(file_path, "rb") as source:
        sample_bytes = source.read(max_bytes)
    return base64.b64encode(sample_bytes).decode("utf-8"), file_size


def human_file_size(size: int) -> str:
    if size == 0:
        return "0 Bytes"
    units = ["Bytes", "KB", "MB", "GB", "TB"]
    idx = min(len(units) - 1, int((size).bit_length() / 10))
    scaled = size / (1024 ** idx)
    return f"{scaled:.2f} {units[idx]}"


def summarize_media(file_path: str, descriptor: MediaDescriptor) -> str:
    """Produce a short textual summary of the media using lightweight heuristics."""
    info_parts = [
        f"文件名: {os.path.basename(file_path)}",
        f"类型: {descriptor.media_type}",
        f"MIME: {descriptor.mime_type}",
    ]
    size_bytes = os.path.getsize(file_path)
    descriptor.size_bytes = size_bytes
    info_parts.append(f"大小: {human_file_size(size_bytes)}")

    # Lazy metadata extraction to avoid heavy dependencies.
    if descriptor.media_type == "image":
        try:
            from PIL import Image  # type: ignore

            with Image.open(file_path) as img:
                width, height = img.size
                mode = img.mode
            info_parts.append(f"分辨率: {width}x{height}")
            info_parts.append(f"颜色模式: {mode}")
        except Exception as exc:  # pragma: no cover - best effort metadata
            info_parts.append(f"图像元数据提取失败: {exc}")
    elif descriptor.media_type == "audio":
        try:
            import wave

            with wave.open(file_path, "rb") as wav_file:
                frames = wav_file.getnframes()
                frame_rate = wav_file.getframerate()
                channels = wav_file.getnchannels()
                duration = frames / float(frame_rate or 1)
            info_parts.append(f"声道数: {channels}")
            info_parts.append(f"采样率: {frame_rate} Hz")
            info_parts.append(f"时长: {duration:.2f} 秒")
        except Exception as exc:  # pragma: no cover - not all formats supported
            info_parts.append(f"音频元数据提取失败: {exc}")
    elif descriptor.media_type == "video":
        try:
            import cv2  # type: ignore

            capture = cv2.VideoCapture(file_path)
            frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = capture.get(cv2.CAP_PROP_FPS) or 0
            width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
            duration = frame_count / float(fps or 1)
            capture.release()
            info_parts.append(f"分辨率: {width}x{height}")
            info_parts.append(f"帧率: {fps:.2f} FPS")
            info_parts.append(f"时长: {duration:.2f} 秒")
        except Exception as exc:  # pragma: no cover - CV metadata optional
            info_parts.append(f"视频元数据提取失败: {exc}")
    else:
        info_parts.append("媒体类型未知或暂不支持详细元数据。")

    return "\n".join(info_parts)
