import axios from "axios";
import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ApiClient } from "../../../src/api-client";
import { registerProjectFilesTools } from "../../../src/mcp/tools/project-files";

jest.mock("../../../src/api-client");
jest.mock("../../../src/logger");
jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;

type ListCallback = (args: { path?: string }) => Promise<{
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
}>;
type ReadCallback = (args: { path: string }) => Promise<{
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
}>;

describe("project-files MCP tools", () => {
  let listCallback: ListCallback;
  let readCallback: ReadCallback;
  const registeredNames: string[] = [];
  const writtenFiles: string[] = [];

  function setupTools(mockClient: Partial<ApiClient>) {
    registeredNames.length = 0;
    const mockServer = {
      tool: jest
        .fn()
        .mockImplementation(
          (name: string, _d: string, _s: unknown, cb: unknown) => {
            registeredNames.push(name);
            if (name === "list_project_files") {
              listCallback = cb as ListCallback;
            } else {
              readCallback = cb as ReadCallback;
            }
          },
        ),
    } as unknown as McpServer;

    registerProjectFilesTools(mockServer, mockClient as ApiClient);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    for (const file of writtenFiles.splice(0)) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  describe("登録", () => {
    it("list_project_files と read_project_file を登録する", () => {
      setupTools({});

      expect(registeredNames).toEqual([
        "list_project_files",
        "read_project_file",
      ]);
    });
  });

  describe("list_project_files", () => {
    it("一覧を JSON テキストとして返す", async () => {
      const listProjectFiles = jest.fn().mockResolvedValue([
        {
          id: "id-1",
          name: "server.pem",
          path: "certs/server.pem",
          type: "file",
          size: 1024,
          contentType: "text/plain",
          modified: "2026-08-01T00:00:00.000Z",
        },
      ]);
      setupTools({ listProjectFiles } as unknown as Partial<ApiClient>);

      const result = await listCallback({ path: "certs" });

      expect(listProjectFiles).toHaveBeenCalledWith("certs");
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed).toEqual([
        {
          name: "server.pem",
          path: "certs/server.pem",
          type: "file",
          size: 1024,
          modified: "2026-08-01T00:00:00.000Z",
        },
      ]);
    });

    it("path 省略時は undefined を渡す（ルート一覧）", async () => {
      const listProjectFiles = jest.fn().mockResolvedValue([]);
      setupTools({ listProjectFiles } as unknown as Partial<ApiClient>);

      await listCallback({});

      expect(listProjectFiles).toHaveBeenCalledWith(undefined);
    });

    it("API エラーはエラーレスポンスとして返す（例外を投げない）", async () => {
      const listProjectFiles = jest
        .fn()
        .mockRejectedValue(new Error("forbidden"));
      setupTools({ listProjectFiles } as unknown as Partial<ApiClient>);

      const result = await listCallback({});

      expect(result.content[0].text).toContain("forbidden");
    });
  });

  describe("read_project_file", () => {
    it("テキストファイルは内容をそのまま返す", async () => {
      const getProjectFileDownloadUrl = jest.fn().mockResolvedValue({
        downloadUrl: "https://s3/get",
        filename: "note.txt",
        contentType: "text/plain",
      });
      mockedAxios.get.mockResolvedValue({ data: "hello world" });
      setupTools({
        getProjectFileDownloadUrl,
      } as unknown as Partial<ApiClient>);

      const result = await readCallback({ path: "note.txt" });

      expect(getProjectFileDownloadUrl).toHaveBeenCalledWith("note.txt");
      expect(result.content[0].text).toContain("hello world");
    });

    it("画像は image コンテンツとして base64 で返す", async () => {
      const getProjectFileDownloadUrl = jest.fn().mockResolvedValue({
        downloadUrl: "https://s3/get",
        filename: "logo.png",
        contentType: "image/png",
      });
      mockedAxios.get.mockResolvedValue({
        data: Buffer.from([0x89, 0x50]).buffer,
      });
      setupTools({
        getProjectFileDownloadUrl,
      } as unknown as Partial<ApiClient>);

      const result = await readCallback({ path: "logo.png" });

      expect(result.content[0].type).toBe("image");
      expect(result.content[0].mimeType).toBe("image/png");
    });

    it("バイナリは一時ファイルへ保存してパスを返す", async () => {
      const getProjectFileDownloadUrl = jest.fn().mockResolvedValue({
        downloadUrl: "https://s3/get",
        filename: "book.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      mockedAxios.get.mockResolvedValue({
        data: Buffer.from("binary-content").buffer,
      });
      setupTools({
        getProjectFileDownloadUrl,
      } as unknown as Partial<ApiClient>);

      const result = await readCallback({ path: "book.xlsx" });

      const text = result.content[0].text as string;
      const match = text.match(/Saved to: (.+)/);
      expect(match).not.toBeNull();
      const savedPath = (match as RegExpMatchArray)[1].trim();
      writtenFiles.push(savedPath);
      expect(fs.existsSync(savedPath)).toBe(true);
      expect(path.basename(savedPath)).toMatch(/^[0-9a-f]{8}_book\.xlsx$/);
    });

    it("サーバー由来のファイル名にパス区切りが含まれても一時ディレクトリ外へ書き出さない", async () => {
      const getProjectFileDownloadUrl = jest.fn().mockResolvedValue({
        downloadUrl: "https://s3/get",
        filename: "../../evil.bin",
        contentType: "application/octet-stream",
      });
      mockedAxios.get.mockResolvedValue({
        data: Buffer.from("x").buffer,
      });
      setupTools({
        getProjectFileDownloadUrl,
      } as unknown as Partial<ApiClient>);

      const result = await readCallback({ path: "evil.bin" });

      const text = result.content[0].text as string;
      const savedPath = (
        text.match(/Saved to: (.+)/) as RegExpMatchArray
      )[1].trim();
      writtenFiles.push(savedPath);
      expect(path.basename(savedPath)).toMatch(/^[0-9a-f]{8}_evil\.bin$/);
      expect(savedPath).toContain("ai-support-agent-project-files");
      expect(savedPath).not.toContain("..");
    });

    it("API エラーはエラーレスポンスとして返す（例外を投げない）", async () => {
      const getProjectFileDownloadUrl = jest
        .fn()
        .mockRejectedValue(new Error("not found"));
      setupTools({
        getProjectFileDownloadUrl,
      } as unknown as Partial<ApiClient>);

      const result = await readCallback({ path: "missing.txt" });

      expect(result.content[0].text).toContain("not found");
    });
  });
});
