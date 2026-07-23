from src import status_store


class FakeRedis:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def setex(self, key, _ttl, value):
        self.values[key] = value


def test_successful_retry_clears_previous_error(monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr(status_store, "get_redis", lambda: redis)

    status_store.create_status("message-1", ["recipient@example.com"], "Hello", "sender-1")
    status_store.update_status("message-1", "queued", error="Retry 1: temporary failure")
    status_store.update_status("message-1", "sending", clear_error=True)
    result = status_store.update_status("message-1", "sent", details={"sent_at": "now"})

    assert result["status"] == "sent"
    assert result["error"] is None
