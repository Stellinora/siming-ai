"""A device's project access must not expose the owner's global recycle bin."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.bootstrap.http_security import GatewayAuthenticationMiddleware


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/v1/recycle-bin"),
        ("POST", "/api/v1/recycle-bin/deleted-project/restore"),
        ("DELETE", "/api/v1/recycle-bin/deleted-project"),
    ],
)
@pytest.mark.parametrize("client_host", ["192.168.1.99", "127.0.0.1"])
@pytest.mark.parametrize("role", ["editor", "owner"])
def test_paired_phone_cannot_access_global_recycle_bin(
    monkeypatch, method, path, client_host, role,
):
    import app.database.session as database
    from app.modules.gateway.infrastructure.service import GatewayService

    monkeypatch.setattr(database, "SessionLocal", MagicMock())
    monkeypatch.setattr(
        GatewayService,
        "authenticate",
        lambda _self, _token: SimpleNamespace(
            role=role, platform="android", device_id="paired-phone",
        ),
    )
    app = FastAPI()
    touched = []

    async def private_handler():
        touched.append(True)
        return {"private_data": True}

    app.add_api_route(path, private_handler, methods=[method])
    app.add_middleware(GatewayAuthenticationMiddleware, enabled=True)
    with TestClient(app, client=(client_host, 41000)) as client:
        response = client.request(method, path, headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 404
    assert not touched


@pytest.mark.parametrize("method", ["GET", "POST", "DELETE"])
def test_authenticated_web_owner_can_manage_recycle_bin(method):
    owner = SimpleNamespace(role="owner", platform="web")
    assert GatewayAuthenticationMiddleware._authorize_remote_path(
        {"path": "/api/v1/recycle-bin/entry-1/restore", "method": method}, owner,
    )
