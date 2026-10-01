# k3s / Kubernetes エージェントのRDP設定

セットアップレシピの既存 `ai_support_agent_k8s` タスクに
`ai_support_agent_k8s_rdp: true` を追加すると、同じPodにguacdを配置します。
この設定に対応したAPIとエージェントの両方への更新が必要です。

```yaml
- name: KubernetesへRDP対応エージェントを配置
  ansible.builtin.include_role:
    name: ai_support_agent_k8s
  vars:
    ai_support_agent_k8s_project: 00000001/AI_SUPPORT_AGENT
    ai_support_agent_k8s_token: "{{ MY_AGENT_TOKEN }}"
    ai_support_agent_k8s_name: ai-support-agent
    ai_support_agent_k8s_rdp: true
```

`MY_AGENT_TOKEN` はプロジェクトの `ANSIBLE#` 秘匿変数として設定してください。
既存レシピのトークン・名前・API URL・イメージ設定はそのまま利用できます。
開発環境では `ai_support_agent_k8s_api_url` を開発APIに設定します。

| 変数 | 既定 | 意味 |
|---|---|---|
| `ai_support_agent_k8s_rdp` | `false` | RDP用guacdサイドカーを追加する。`true` / `false` または同じ値の文字列 |
| `ai_support_agent_k8s_guacd_image` | `guacamole/guacd:1.5.5` | 公式guacdイメージ。`guacamole/guacd:<tag>` のみ許可 |

複数プロジェクトでは、トップレベルの値を継承し、エントリの `rdp` と
`guacd_image` で個別に上書きできます。`rdp: false` はトップレベルの有効化を解除します。

```yaml
- name: プロジェクト別にエージェントを配置
  ansible.builtin.include_role:
    name: ai_support_agent_k8s
  vars:
    ai_support_agent_k8s_projects:
      - project: 00000001/AI_SUPPORT_AGENT
        name: ai-support-agent
        token: "{{ MY_AGENT_TOKEN }}"
        rdp: true
      - project: 00000001/JCCI_ECO
        name: jcci-eco-agent
        token: "{{ JCCI_AGENT_TOKEN }}"
        rdp: false
```

guacdは同一Podの `127.0.0.1:4822` でのみ待ち受けます。ServiceやhostPortを
追加する必要はありません。プロジェクトのRDP機能を有効にし、Podから接続先の
RDPポート（通常3389）へ到達できる経路を用意してください。

既定guacdイメージはamd64です。ARM64ノードでは、そのCPUに対応する公式イメージを
検証して指定するか、amd64ノードへ配置してください。MacのRosettaには依存しません。
guacdはUID/GID 1000で起動します。イメージを変更する場合は、このUID/GIDでの
実行と上記guacd起動コマンドの互換性も確認してください。

設定変更時はPodが更新されます。自分自身のエージェントを対象とする場合は、
既存の自己再起動待ち処理で他プロジェクトの配置後に更新します。
レシピ実行後、次を確認してください（名前空間とStatefulSet名は設定に合わせます）。

```bash
kubectl -n ai-support-agent get pods
kubectl -n ai-support-agent logs ai-support-agent-0 -c guacd
```

guacdの起動を確認し、コンソールからRDP接続を試してください。
`rdp: false` に戻してレシピを実行すると、guacdと接続先環境変数を削除します。

開発時のテンプレート・入力検証テストはAnsibleを導入したPython環境で実行します。

```bash
python ansible/tests/test_k3s_rdp_manifest.py
```
