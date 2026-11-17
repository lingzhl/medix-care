import base64
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app.engine import ChatRequest, KnowledgeCard, choose_agents, live_contribution
from backend.app.main import app


class RoutingTests(unittest.TestCase):
    def test_single_and_parallel_routes(self):
        self.assertEqual(choose_agents("高血压日常管理"), ["健康咨询"])
        self.assertEqual(choose_agents("咳嗽和发烧怎么办"), ["症状分析", "健康咨询"])
        self.assertEqual(choose_agents("胸痛相关临床指南有哪些"), ["症状分析", "循证检索", "健康咨询"])

    def test_image_requires_real_supported_data(self):
        valid_png = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"test").decode()
        self.assertEqual(ChatRequest(message="请解释这张图", image=valid_png).image, valid_png)
        with self.assertRaises(ValueError):
            ChatRequest(message="请解释这张图", image="data:image/png;base64," + base64.b64encode(b"not-png").decode())


class ModelRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_request_includes_evidence_and_image(self):
        sent = {}

        class FakeResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {"choices": [{"message": {"content": "模型回答"}}]}

        class FakeClient:
            def __init__(self, timeout, trust_env):
                self.timeout = timeout
                sent["trust_env"] = trust_env

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def post(self, url, headers, json):
                sent.update(url=url, headers=headers, body=json)
                return FakeResponse()

        png = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"test").decode()
        request = ChatRequest(message="解释这张图片", image=png)
        cards = [KnowledgeCard("example", "示例知识", "测试", "摘要", "建议")]
        env = {"MEDIX_MODEL_BASE_URL": "https://example.invalid/v1", "MEDIX_MODEL_NAME": "vision-model", "MEDIX_MODEL_API_KEY": "test-key"}
        with patch.dict(os.environ, env), patch("backend.app.engine.httpx.AsyncClient", FakeClient):
            self.assertEqual(await live_contribution("健康咨询", request, cards), "模型回答")
        self.assertEqual(sent["url"], "https://example.invalid/v1/chat/completions")
        self.assertTrue(sent["trust_env"])
        self.assertEqual(sent["body"]["model"], "vision-model")
        self.assertEqual(sent["body"]["messages"][-1]["content"][1]["image_url"]["url"], png)
        self.assertIn("示例知识", sent["body"]["messages"][0]["content"])

    async def test_local_model_bypasses_system_proxy(self):
        requests = []

        class FakeClient:
            def __init__(self, timeout, trust_env):
                requests.append((timeout, trust_env))

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def post(self, *args, **kwargs):
                class Response:
                    def raise_for_status(self):
                        pass

                    def json(self):
                        return {"choices": [{"message": {"content": "ok"}}]}
                return Response()

        env = {"MEDIX_MODEL_BASE_URL": "http://127.0.0.1:8010/v1", "MEDIX_MODEL_NAME": "medix-r1-2b", "MEDIX_MODEL_API_KEY": "test-key"}
        with patch.dict(os.environ, env), patch("backend.app.engine.httpx.AsyncClient", FakeClient):
            await live_contribution("健康咨询", ChatRequest(message="健康咨询"), [])
        self.assertEqual(requests, [(120, False)])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_demo_swarm_risk_and_image_limit(self):
        with patch.dict(os.environ, {"MEDIX_MODE": "demo"}):
            response = self.client.post("/api/chat", json={"message": "胸痛和呼吸困难，相关指南怎么说？"})
            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["route"], "swarm")
            self.assertTrue(body["high_risk"])
            self.assertEqual(body["mode"], "demo")
            self.assertTrue(body["evidence"])
            self.assertIn("不能替代医生", body["answer"])

            png = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"test").decode()
            image_response = self.client.post("/api/chat", json={"message": "解释图片", "image": png})
            self.assertFalse(image_response.json()["image_analyzed"])
            self.assertIn("不会分析图像", image_response.json()["answer"])

    def test_live_mode_requires_auth_and_vision_model(self):
        env = {
            "MEDIX_MODE": "live",
            "MEDIX_ACCESS_TOKEN": "test-secret",
            "MEDIX_MODEL_BASE_URL": "https://example.invalid/v1",
            "MEDIX_MODEL_NAME": "test-model",
            "MEDIX_MODEL_API_KEY": "test-key",
            "MEDIX_MODEL_SUPPORTS_VISION": "false",
        }
        png = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"test").decode()
        with patch.dict(os.environ, env):
            self.assertEqual(self.client.post("/api/chat", json={"message": "你好"}).status_code, 401)
            response = self.client.post("/api/chat", headers={"X-Medix-Access-Token": "test-secret"}, json={"message": "解释图片", "image": png})
            self.assertEqual(response.status_code, 400)
            self.assertFalse(self.client.get("/api/health").json()["vision_enabled"])

    def test_invalid_mode_fails_closed(self):
        with patch.dict(os.environ, {"MEDIX_MODE": "invalid"}):
            self.assertEqual(self.client.post("/api/chat", json={"message": "你好"}).status_code, 503)


if __name__ == "__main__":
    unittest.main()
