"""Render the bundled role with Ansible's actual filters, without touching a cluster.

Run with the Python environment used for ansible-playbook:
  python ansible/tests/test_k3s_rdp_manifest.py
"""
import unittest
from pathlib import Path

import yaml
from ansible.parsing.dataloader import DataLoader
from ansible.template import Templar


ROLE = Path(__file__).resolve().parents[1] / "roles" / "ai_support_agent_k8s"


def read_yaml(relative):
    return yaml.safe_load((ROLE / relative).read_text())


class RdpManifestTests(unittest.TestCase):
    def templar(self, **overrides):
        variables = read_yaml("defaults/main.yml")
        variables.update({"item": {"name": "test-agent", "project": "test/TEST", "token": "test-token"}})
        variables.update(overrides)
        return Templar(loader=DataLoader(), variables=variables)

    def render(self, **overrides):
        task = next(t for t in read_yaml("tasks/project.yml")
                    if t["name"].endswith("Write the StatefulSet manifest"))
        text = self.templar(**overrides).template(task["ansible.builtin.copy"]["content"])
        return yaml.safe_load(text)

    def test_rdp_and_persistence_matrix(self):
        for global_rdp in (False, True, "true", "false"):
            for local_rdp in (None, False, True):
                for persistence in (False, True):
                    with self.subTest(global_rdp=global_rdp, local_rdp=local_rdp, persistence=persistence):
                        item = {"name": "test-agent", "project": "test/TEST", "token": "test-token"}
                        if local_rdp is not None:
                            item["rdp"] = local_rdp
                        enabled = local_rdp if local_rdp is not None else str(global_rdp).lower() == "true"
                        doc = self.render(item=item, ai_support_agent_k8s_rdp=global_rdp,
                                          ai_support_agent_k8s_persistence=persistence)
                        pod = doc["spec"]["template"]["spec"]
                        containers = pod["containers"]
                        self.assertEqual([c["name"] for c in containers], ["agent", "guacd"] if enabled else ["agent"])
                        env = {e["name"]: e.get("value") for e in containers[0]["env"]}
                        self.assertEqual("GUACD_HOST" in env, enabled)
                        self.assertEqual("volumeClaimTemplates" in doc["spec"], persistence)
                        self.assertEqual("volumes" in pod, enabled)
                        self.assertEqual("securityContext" in pod, enabled)
                        if enabled:
                            self.assertEqual(env["GUACD_HOST"], "127.0.0.1")
                            self.assertEqual(env["GUACD_PORT"], "4822")
                            self.assertEqual(env["AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN"], "loopback")
                            guacd = containers[1]
                            self.assertEqual(guacd["securityContext"]["runAsUser"], 1000)
                            self.assertEqual(guacd["securityContext"]["runAsGroup"], 1000)
                            self.assertTrue(guacd["securityContext"]["readOnlyRootFilesystem"])
                            self.assertEqual(pod["securityContext"]["fsGroup"], 1000)
                            self.assertEqual(guacd["volumeMounts"], [{"name": "guacd-home", "mountPath": "/home/guacd"}])
                            self.assertEqual(pod["volumes"], [{"name": "guacd-home", "emptyDir": {"medium": "Memory", "sizeLimit": "64Mi"}}])
                            self.assertIn({"name": "HOME", "value": "/home/guacd"}, guacd["env"])
                            self.assertNotIn("guacd-home", [m["name"] for m in containers[0].get("volumeMounts", [])])
                            self.assertEqual(guacd["image"], "guacamole/guacd:1.5.5")
                            self.assertIn("-b 127.0.0.1", guacd["command"][2])
                            self.assertNotIn("hostPort", guacd["ports"][0])
                            self.assertFalse(pod.get("hostNetwork", False))

    def test_per_project_image_override(self):
        doc = self.render(ai_support_agent_k8s_rdp=True,
                          item={"name": "test-agent", "project": "test/TEST", "token": "test-token",
                                "guacd_image": "guacamole/guacd:1.6.0"})
        self.assertEqual(doc["spec"]["template"]["spec"]["containers"][1]["image"], "guacamole/guacd:1.6.0")

    def test_invalid_values_fail_assertions(self):
        for relative, suffix, key in (("tasks/main.yml", "Validate RDP settings", "ai_support_agent_k8s_rdp"),
                                     ("tasks/project.yml", "Validate per-project RDP settings", "rdp")):
            task = next(t for t in read_yaml(relative) if t["name"].endswith(suffix))
            for value in ("invalid", "yes", "", 1, None):
                overrides = {key: value} if key.startswith("ai_") else {
                    "item": {"name": "test-agent", key: value}}
                templar = self.templar(**overrides)
                self.assertFalse(templar.template("{{ " + task["ansible.builtin.assert"]["that"][0] + " }}"))
            image_key = "ai_support_agent_k8s_guacd_image" if key.startswith("ai_") else "guacd_image"
            for value in ("evil/guacd:latest", "guacamole/guacd:1.5.5\n", "guacamole/guacd:1.5.5\nextra: injected"):
                overrides = {image_key: value} if key.startswith("ai_") else {
                    "item": {"name": "test-agent", image_key: value}}
                templar = self.templar(**overrides)
                self.assertFalse(templar.template("{{ " + task["ansible.builtin.assert"]["that"][1] + " }}"))


if __name__ == "__main__":
    unittest.main()
