import json
import os
import threading
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests

from .media_utils import MediaDescriptor, encode_file_sample, summarize_media


class DeepSeekError(RuntimeError):
    """Raised when DeepSeek API calls fail."""


@dataclass
class DeepSeekConfig:
    api_key: Optional[str]
    api_base: str
    model: str
    timeout: int = 120


class DeepSeekClient:
    """Thin wrapper around the DeepSeek REST API for multimodal reasoning."""

    def __init__(self, config: Optional[DeepSeekConfig] = None) -> None:
        if config is None:
            config = DeepSeekConfig(
                api_key=os.getenv("DEEPSEEK_API_KEY"),
                api_base=os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1"),
                model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
                timeout=int(os.getenv("DEEPSEEK_TIMEOUT", "120")),
            )
        self.config = config

    # ----------- Public helpers -----------
    @property
    def is_configured(self) -> bool:
        return bool(self.config.api_key)

    def analyze_media(self, file_path: str, descriptor: MediaDescriptor, tasks: List[str], languages: Optional[List[str]] = None) -> Dict[str, Any]:
        """Run multimodal understanding tasks (tags, scene, emotion, moderation)."""
        languages = languages or ["zh", "en"]
        sample_b64, total_size = encode_file_sample(file_path)
        metadata_summary = summarize_media(file_path, descriptor)

        prompt = (
            "你是一个多模态内容理解助手，需要分析上传的媒体文件并返回结构化JSON。"
            "务必遵循以下JSON格式，缺失信息使用null或空数组。"
            "返回字段: tags(字符串数组), scene(string), emotions(字符串数组),"
            "moderation(对象{level, reasons, suggestions}),"
            "recommendations(字符串数组用于推荐场景),"
            "languages(对象, 键为语言代码，值为总结)。"
            "如果任务包含subtitles，请在subtitles字段输出对象，键为语言代码，值为SRT字符串。"
        )

        messages = [
            {
                "role": "system",
                "content": prompt,
            },
            {
                "role": "user",
                "content": (
                    f"任务: {', '.join(tasks)}\n"
                    f"媒体描述:\n{metadata_summary}\n\n"
                    f"文件内容Base64前缀(<=2MB): {sample_b64}\n"
                    f"目标语言: {', '.join(languages)}"
                ),
            },
        ]

        response = self._chat_completion(messages, response_format="json_object")
        data = self._parse_json_content(response)
        data["fileSize"] = total_size
        data["mediaType"] = descriptor.media_type
        return data

    def generate_subtitles(self, file_path: str, descriptor: MediaDescriptor, languages: List[str]) -> Dict[str, Any]:
        sample_b64, total_size = encode_file_sample(file_path)
        metadata_summary = summarize_media(file_path, descriptor)
        prompt = (
            "你是语音和视频字幕生成专家。根据音视频内容生成多语言字幕，输出JSON对象"
            "，键为语言代码，值为SRT格式字符串。字幕需匹配媒体时长，语言列表来自输入。"
            "如遇静音或内容不足，需要给出合理说明。"
        )
        messages = [
            {"role": "system", "content": prompt},
            {
                "role": "user",
                "content": (
                    f"目标语言: {', '.join(languages)}\n"
                    f"媒体描述:\n{metadata_summary}\n"
                    f"Base64片段: {sample_b64}"
                ),
            },
        ]
        response = self._chat_completion(messages, response_format="json_object", temperature=0.3, max_tokens=2000)
        subtitles = self._parse_json_content(response)
        return {
            "mediaType": descriptor.media_type,
            "fileSize": total_size,
            "subtitles": subtitles,
        }

    def moderate_media(self, file_path: str, descriptor: MediaDescriptor) -> Dict[str, Any]:
        sample_b64, _ = encode_file_sample(file_path)
        metadata_summary = summarize_media(file_path, descriptor)
        prompt = (
            "你是内容安全审核专家，需要识别暴力、色情、涉政敏感、违法行为等风险。"
            "请输出JSON: {riskLevel: 'safe'|'warning'|'block', reasons: [], guidance: ''}."
        )
        response = self._chat_completion(
            [
                {"role": "system", "content": prompt},
                {
                    "role": "user",
                    "content": (
                        "请根据以下媒体信息做出判断。\n"
                        f"媒体描述:\n{metadata_summary}\n"
                        f"内容Base64片段: {sample_b64}"
                    ),
                },
            ],
            response_format="json_object",
        )
        return self._parse_json_content(response)

    # ----------- Internal helpers -----------
    def _chat_completion(
        self,
        messages: List[Dict[str, str]],
        response_format: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not self.is_configured:
            raise DeepSeekError("DeepSeek API key not configured")

        url = f"{self.config.api_base.rstrip('/')}/chat/completions"
        payload: Dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature,
        }
        if response_format:
            payload["response_format"] = {"type": response_format}
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

        response = requests.post(url, headers=headers, json=payload, timeout=self.config.timeout)
        if response.status_code >= 400:
            raise DeepSeekError(f"DeepSeek API error {response.status_code}: {response.text}")
        return response.json()

    def _parse_json_content(self, response: Dict[str, Any]) -> Dict[str, Any]:
        try:
            content = response["choices"][0]["message"]["content"]
            return json.loads(content)
        except (KeyError, IndexError, json.JSONDecodeError) as exc:
            raise DeepSeekError(f"无法解析DeepSeek返回内容: {exc}")


class MockDeepSeekClient(DeepSeekClient):
    """Fallback client when API key is missing; produces heuristic results."""

    def __init__(self) -> None:  # pragma: no cover - trivial init
        super().__init__(DeepSeekConfig(api_key=None, api_base="", model="mock"))

    @property
    def is_configured(self) -> bool:  # always false
        return False

    def analyze_media(self, file_path: str, descriptor: MediaDescriptor, tasks: List[str], languages: Optional[List[str]] = None) -> Dict[str, Any]:
        from random import choice

        base_tags = {
            "image": [["风景", "自然"], ["人物", "自拍"], ["美食", "甜品"], ["城市", "夜景"]],
            "video": [["剧情", "短片"], ["旅行", "记录"], ["派对", "音乐"], ["宠物", "日常"]],
            "audio": [["音乐", "欢快"], ["演讲", "励志"], ["播客", "访谈"], ["自然", "白噪声"]],
            "unknown": [["文件", "未识别"]],
        }
        tags = choice(base_tags.get(descriptor.media_type, base_tags["unknown"]))
        emotions = ["欢快", "平静"] if descriptor.media_type != "unknown" else ["未知"]
        scene = {
            "image": "户外",
            "video": "室内",
            "audio": "演播室",
            "unknown": "未知",
        }.get(descriptor.media_type, "未知")
        languages = languages or ["zh", "en"]
        return {
            "mediaType": descriptor.media_type,
            "tags": tags,
            "scene": scene,
            "emotions": emotions,
            "moderation": {
                "level": "safe",
                "reasons": [],
                "suggestions": "正常内容，可放心使用",
            },
            "recommendations": ["智能推荐示例"],
            "languages": {lang: f"示例描述（{lang}）" for lang in languages},
        }

    def generate_subtitles(self, file_path: str, descriptor: MediaDescriptor, languages: List[str]) -> Dict[str, Any]:
        subtitles = {}
        for lang in languages:
            subtitles[lang] = """1
00:00:00,000 --> 00:00:02,000
[示例字幕] 这是一个占位字幕。"""
        return {"mediaType": descriptor.media_type, "fileSize": 0, "subtitles": subtitles}

    def moderate_media(self, file_path: str, descriptor: MediaDescriptor) -> Dict[str, Any]:
        return {"riskLevel": "safe", "reasons": [], "guidance": "示例环境下未检测到违规内容"}


_client_lock = threading.Lock()
_cached_client: Optional[DeepSeekClient] = None


def get_ai_client() -> DeepSeekClient:
    global _cached_client
    with _client_lock:
        if _cached_client:
            return _cached_client
        candidate = DeepSeekClient()
        if candidate.is_configured:
            _cached_client = candidate
        else:
            _cached_client = MockDeepSeekClient()
        return _cached_client
