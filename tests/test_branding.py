from src.api import app


def test_sendplug_api_branding():
    assert app.title == "SendPlug API"
    assert "plug-and-play email delivery" in app.description.lower()
