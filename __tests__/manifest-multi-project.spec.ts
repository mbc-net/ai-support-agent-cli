import { loadAll } from 'js-yaml'

import {
  generateEcsManifest,
  generateK8sManifest,
  InvalidManifestNameError,
} from '../src/manifest/manifest-generator'

/**
 * 複数プロジェクト対応（1プロジェクト = 1 Deployment）。
 * web 側の対になるテストは web/src/lib/__tests__/agent-deploy-manifest.test.ts。
 * 生成規則を変えるときは両方を同時に更新すること。
 */

describe("generateK8sManifest の複数プロジェクト対応", () => {
  const MULTI = {
    tenantCode: "mbc",
    apiUrl: "https://api.example.com",
    projects: [
      { projectCode: "MBC_01", token: "tok-1", name: "agent-mbc01", replicas: 2 },
      { projectCode: "MBC_02", token: "tok-2", name: "agent-mbc02" },
    ],
  };

  it("プロジェクトごとに Secret と Deployment を1組ずつ生成する", () => {
    const docs = loadAll(generateK8sManifest(MULTI)) as Record<string, any>[];
    const kinds = docs.map((d) => `${d.kind}:${d.metadata.name}`);
    expect(kinds).toEqual([
      "Secret:agent-mbc01-token",
      "Deployment:agent-mbc01",
      "Secret:agent-mbc02-token",
      "Deployment:agent-mbc02",
    ]);
  });

  it("エントリごとのレプリカ数を反映し、未指定は1にする", () => {
    const docs = loadAll(generateK8sManifest(MULTI)) as Record<string, any>[];
    const deployments = docs.filter((d) => d.kind === "Deployment");
    expect(deployments[0].spec.replicas).toBe(2);
    expect(deployments[1].spec.replicas).toBe(1);
  });

  it("各 Deployment が自分のプロジェクトと自分の Secret を参照する", () => {
    // トークンはエージェントIDの導出元であり、取り違えると別プロジェクトの
    // エージェントIDで接続してサーバー側に拒否される。
    const docs = loadAll(generateK8sManifest(MULTI)) as Record<string, any>[];
    const deployments = docs.filter((d) => d.kind === "Deployment");
    const container = (d: Record<string, any>) =>
      d.spec.template.spec.containers[0];
    expect(container(deployments[0]).args).toContain("mbc/MBC_01");
    expect(container(deployments[1]).args).toContain("mbc/MBC_02");
    const secretRef = (d: Record<string, any>) =>
      container(d).env.find((e: any) => e.name === "AI_SUPPORT_AGENT_TOKEN")
        .valueFrom.secretKeyRef.name;
    expect(secretRef(deployments[0])).toBe("agent-mbc01-token");
    expect(secretRef(deployments[1])).toBe("agent-mbc02-token");
  });

  it("単数指定と複数指定の同時指定を拒否する", () => {
    expect(() =>
      generateK8sManifest({ ...MULTI, projectCode: "MBC_09", token: "tok-9" }),
    ).toThrow(/mutually exclusive/i);
  });

  it("プロジェクト未指定を拒否する", () => {
    expect(() =>
      generateK8sManifest({ tenantCode: "mbc", apiUrl: "https://api.example.com" }),
    ).toThrow(/at least one/i);
  });

  it("エントリ名の重複を拒否する（後勝ちで片方が消えるため）", () => {
    expect(() =>
      generateK8sManifest({
        ...MULTI,
        projects: [
          { projectCode: "MBC_01", token: "tok-1", name: "same" },
          { projectCode: "MBC_02", token: "tok-2", name: "same" },
        ],
      }),
    ).toThrow(/unique/i);
  });

  it("エントリ名が DNS-1123 ラベルでない場合は拒否する", () => {
    expect(() =>
      generateK8sManifest({
        ...MULTI,
        projects: [{ projectCode: "MBC_01", token: "t", name: "MBC_01" }],
      }),
    ).toThrow(InvalidManifestNameError);
  });
});

describe("generateEcsManifest の複数プロジェクト指定", () => {
  const ECS_BASE = {
    tenantCode: "mbc",
    apiUrl: "https://api.example.com",
    cluster: "c",
    subnets: ["s"],
    securityGroups: ["g"],
  };

  it("projects 1件でも単数指定と同じ内容を生成する", () => {
    const viaList = generateEcsManifest({
      ...ECS_BASE,
      projects: [{ projectCode: "MBC_01", token: "tok", replicas: 2 }],
    });
    const viaSingle = generateEcsManifest({
      ...ECS_BASE,
      projectCode: "MBC_01",
      token: "tok",
      replicas: 2,
    });
    expect(JSON.parse(viaList.taskDefinition)).toEqual(
      JSON.parse(viaSingle.taskDefinition),
    );
    expect(JSON.parse(viaList.service)).toEqual(JSON.parse(viaSingle.service));
  });

  it("projects が2件以上なら明示的に拒否する（1タスク定義=1プロジェクトのため）", () => {
    // 黙って先頭だけ採用すると、2件目のプロジェクトが起動しないことに
    // 気づけない。ECS は K8s と違い1ファイルに複数定義をまとめられない。
    expect(() =>
      generateEcsManifest({
        ...ECS_BASE,
        projects: [
          { projectCode: "MBC_01", token: "t1", name: "a" },
          { projectCode: "MBC_02", token: "t2", name: "b" },
        ],
      }),
    ).toThrow(/one project/i);
  });

  it("プロジェクト未指定なら undefined を埋め込まずエラーにする", () => {
    expect(() => generateEcsManifest(ECS_BASE)).toThrow(/at least one/i);
  });
});

describe("レビュー指摘の回帰: 単数指定の部分指定と空 name", () => {
  const T = { tenantCode: "mbc", apiUrl: "https://api.example.com" };

  it("projectCode だけ / token だけの部分指定を拒否する", () => {
    // OR 判定だと片方だけでも「単数指定あり」となり、非null断定を通って
    // `--project mbc/undefined` が埋め込まれたマニフェストが生成される。
    expect(() => generateK8sManifest({ ...T, token: "tok" } as never)).toThrow(
      /together/i,
    );
    expect(() =>
      generateK8sManifest({ ...T, projectCode: "MBC_01" } as never),
    ).toThrow(/together/i);
  });

  it("空文字の name を既定名へ黙ってフォールバックさせない", () => {
    // web と agent でフォールバック演算子が食い違うと、同じ入力で
    // 片方だけがマニフェストを生成してしまいパリティが崩れる。
    expect(() =>
      generateK8sManifest({
        ...T,
        projects: [{ projectCode: "MBC_01", token: "t", name: "" }],
      }),
    ).toThrow(InvalidManifestNameError);
  });

  it("エラークラスが実体として import できている（toThrow(undefined) 化の防止）", () => {
    // 未定義シンボルを toThrow に渡すと Jest は「何か throw されたか」しか見ない。
    // tsconfig が __tests__ を型検査から外しているため import ミスはビルドでも
    // 検出されない。実体があることを直接固定する。
    expect(InvalidManifestNameError).toBeDefined()
    expect(typeof InvalidManifestNameError).toBe('function')
  })

  it("生成物に undefined が混入しない", () => {
    const m = generateK8sManifest({
      ...T,
      projects: [{ projectCode: "MBC_01", token: "t", name: "agent-mbc01" }],
    });
    expect(m).not.toContain("undefined");
  });
});
