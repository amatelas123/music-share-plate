import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional


@dataclass
class AIJob:
    job_id: str
    label: str
    status: str = "pending"  # pending, running, completed, failed
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "jobId": self.job_id,
            "label": self.label,
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class AIJobManager:
    def __init__(self, max_workers: int = 3):
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="ai-job")
        self._jobs: Dict[str, AIJob] = {}
        self._lock = threading.Lock()

    def submit(self, label: str, func: Callable[..., Dict[str, Any]], *args: Any, **kwargs: Any) -> AIJob:
        job_id = uuid.uuid4().hex
        job = AIJob(job_id=job_id, label=label)
        with self._lock:
            self._jobs[job_id] = job

        def _runner() -> None:
            self._update_status(job_id, "running")
            try:
                result = func(*args, **kwargs)
                self._update_status(job_id, "completed", result=result)
            except Exception as exc:  # pragma: no cover - background error logging
                self._update_status(job_id, "failed", error=str(exc))

        self._executor.submit(_runner)
        return job

    def _update_status(self, job_id: str, status: str, result: Optional[Dict[str, Any]] = None, error: Optional[str] = None) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job.status = status
            job.updated_at = time.time()
            if result is not None:
                job.result = result
            if error is not None:
                job.error = error

    def get(self, job_id: str) -> Optional[AIJob]:
        with self._lock:
            return self._jobs.get(job_id)

    def list_jobs(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {job_id: job.to_dict() for job_id, job in self._jobs.items()}


# Global manager instance for convenience
_global_manager: Optional[AIJobManager] = None


def get_job_manager() -> AIJobManager:
    global _global_manager
    if _global_manager is None:
        _global_manager = AIJobManager()
    return _global_manager


def reset_job_manager() -> None:  # pragma: no cover - mainly for tests
    global _global_manager
    if _global_manager:
        _global_manager = AIJobManager()


# Alias for import convenience
global_job_manager = get_job_manager()
