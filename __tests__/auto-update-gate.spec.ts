import {
  createAutoUpdateClients,
  createAutoUpdateGate,
  fetchServerAutoUpdateEnabled,
} from '../src/auto-update-gate'
import type { ApiClient } from '../src/api-client'

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

function clientReturning(
  autoUpdateEnabled: boolean | undefined,
): ApiClient {
  return {
    getConfig: jest.fn().mockResolvedValue({ autoUpdateEnabled }),
  } as unknown as ApiClient
}

function clientFailing(): ApiClient {
  return {
    getConfig: jest.fn().mockRejectedValue(new Error('network down')),
  } as unknown as ApiClient
}

describe('fetchServerAutoUpdateEnabled', () => {
  it('全プロジェクトが有効なら true', async () => {
    await expect(
      fetchServerAutoUpdateEnabled([clientReturning(true), clientReturning(true)]),
    ).resolves.toBe(true)
  })

  it('1つでも無効なら false（ホスト単位の操作なので fail-closed で揃える）', async () => {
    await expect(
      fetchServerAutoUpdateEnabled([clientReturning(true), clientReturning(false)]),
    ).resolves.toBe(false)
  })

  it('値を返さないプロジェクトが混ざれば undefined（未設定は「無効」ではない）', async () => {
    // false に倒すと、set-auto-update --enable で明示的に有効化してあるホストが
    // 「管理画面で未操作」というだけで停止してしまう。
    await expect(
      fetchServerAutoUpdateEnabled([clientReturning(true), clientReturning(undefined)]),
    ).resolves.toBeUndefined()
  })

  it('どのプロジェクトも値を返さなければ undefined（autoUpdateEnabled を知らない旧 API）', async () => {
    await expect(
      fetchServerAutoUpdateEnabled([clientReturning(undefined)]),
    ).resolves.toBeUndefined()
  })

  it('明示的な無効が1つでもあれば、未設定が混ざっていても false', async () => {
    await expect(
      fetchServerAutoUpdateEnabled([clientReturning(undefined), clientReturning(false)]),
    ).resolves.toBe(false)
  })

  it('取得に失敗したら undefined（「無効」ではなく「サーバー層は判断不能」）', async () => {
    await expect(
      fetchServerAutoUpdateEnabled([clientReturning(true), clientFailing()]),
    ).resolves.toBeUndefined()
  })

  it('クライアントが無ければ undefined', async () => {
    await expect(fetchServerAutoUpdateEnabled([])).resolves.toBeUndefined()
  })
})

describe('createAutoUpdateGate', () => {
  it('サーバーが有効ならローカルが無効でも許可する', async () => {
    const gate = createAutoUpdateGate({
      clients: [clientReturning(true)],
      cli: undefined,
      local: false,
    })

    await expect(gate()).resolves.toBe(true)
  })

  it('サーバーが無効ならローカルが有効でも許可しない', async () => {
    const gate = createAutoUpdateGate({
      clients: [clientReturning(false)],
      cli: undefined,
      local: true,
    })

    await expect(gate()).resolves.toBe(false)
  })

  it('CLI フラグはサーバー設定より優先される', async () => {
    const gate = createAutoUpdateGate({
      clients: [clientReturning(false)],
      cli: true,
      local: false,
    })

    await expect(gate()).resolves.toBe(true)
  })

  it('CLI で明示的に有効化されていればサーバーへ問い合わせない', async () => {
    const client = clientReturning(false)
    const gate = createAutoUpdateGate({ clients: [client], cli: true })

    await gate()

    expect(client.getConfig).not.toHaveBeenCalled()
  })

  it('サーバーが値を持たないときもローカル設定へ落ちる', async () => {
    const gate = createAutoUpdateGate({
      clients: [clientReturning(undefined)],
      cli: undefined,
      local: true,
    })

    await expect(gate()).resolves.toBe(true)
  })

  it('サーバーへ到達できないときはローカル設定へ落ちる', async () => {
    const gate = createAutoUpdateGate({
      clients: [clientFailing()],
      cli: undefined,
      local: true,
    })

    await expect(gate()).resolves.toBe(true)
  })

  it('サーバーへ到達できずローカル設定も無ければ許可しない', async () => {
    const gate = createAutoUpdateGate({ clients: [clientFailing()] })

    await expect(gate()).resolves.toBe(false)
  })

  it('評価のたびにサーバーへ問い合わせる（管理画面の変更が再起動なしで効く）', async () => {
    const getConfig = jest
      .fn()
      .mockResolvedValueOnce({ autoUpdateEnabled: false })
      .mockResolvedValueOnce({ autoUpdateEnabled: true })
    const client = { getConfig } as unknown as ApiClient
    const gate = createAutoUpdateGate({ clients: [client] })

    await expect(gate()).resolves.toBe(false)
    await expect(gate()).resolves.toBe(true)
    expect(getConfig).toHaveBeenCalledTimes(2)
  })
})

describe('createAutoUpdateClients', () => {
  const ok = (apiUrl: string, token: string) =>
    ({ apiUrl, token }) as unknown as ApiClient

  it('全プロジェクトぶんのクライアントを作る', () => {
    const clients = createAutoUpdateClients(
      [
        { apiUrl: 'https://a.example.com', token: 'tok-a' },
        { apiUrl: 'https://b.example.com', token: 'tok-b' },
      ],
      ok,
    )

    expect(clients).toHaveLength(2)
  })

  it('生成に失敗するプロジェクトが1つでもあれば undefined を返す（fail-closed）', () => {
    // ApiClient は HTTP の API URL などで例外を投げる。ここで例外を伝播させると
    // 自動アップデートの初期化がエージェント全体の起動を落とす。かといって
    // 黙って除外すると、そのプロジェクトのサーバー設定を評価しないまま
    // 更新を実行してしまう。どちらも避けるため、更新自体を諦める。
    const clients = createAutoUpdateClients(
      [
        { apiUrl: 'https://a.example.com', token: 'tok-a' },
        { apiUrl: 'http://insecure.example.com', token: 'tok-b' },
      ],
      (apiUrl, token) => {
        if (apiUrl.startsWith('http://')) throw new Error('API URL uses HTTP')
        return ok(apiUrl, token)
      },
    )

    expect(clients).toBeUndefined()
  })

  it('apiUrl / token が欠けたプロジェクトがあれば undefined を返す', () => {
    expect(
      createAutoUpdateClients(
        [{ apiUrl: 'https://a.example.com', token: '' }],
        ok,
      ),
    ).toBeUndefined()
  })

  it('プロジェクトが空なら undefined を返す', () => {
    expect(createAutoUpdateClients([], ok)).toBeUndefined()
  })
})
