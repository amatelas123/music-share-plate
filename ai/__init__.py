"""AI integration package for DeepSeek-powered multimedia intelligence."""

from .deepseek_client import DeepSeekClient, get_ai_client
from .job_manager import AIJobManager, global_job_manager
from .media_utils import detect_media_type
