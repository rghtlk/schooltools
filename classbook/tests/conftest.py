import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def app(tmp_path):
    app = create_app(tmp_path / "data", https_port=8443)
    yield app
    app.state.store.close()


@pytest.fixture
def client(app):
    # base_url with an IP: the host check rejects names like "testserver".
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


@pytest.fixture
def auth(app):
    return {"Authorization": f"Bearer {app.state.code}"}
