import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import axios from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApiClient } from "../../api-client";
import {
  CONVERSATION_BINARY_DOWNLOAD_TIMEOUT_MS,
  CONVERSATION_FILE_DOWNLOAD_TIMEOUT_MS,
} from "../../constants";
import { isImageMime, isTextMime } from "../../utils/content-type";
import {
  mcpImageResponse,
  mcpJsonResponse,
  mcpTextResponse,
  withMcpErrorHandling,
} from "./mcp-response";

/**
 * 1 ファイルあたりの読み取り上限（バイト）。
 *
 * axios はレスポンス全体をメモリにバッファリングするため、上限を設けないと
 * 大容量ファイル（プラン上限が無制限の場合 2GB 近く）を読ませたときに
 * エージェントプロセスが OOM で落ちる。API 側の LLM ツールと同じ 10MB とする。
 */
const MAX_READ_BYTES = 10 * 1024 * 1024

/** 一時ファイルの権限（所有者のみ読み書き）。共有ファイルは証明書・鍵を含み得る。 */
const TEMP_FILE_MODE = 0o600

/** 一時ディレクトリの権限（所有者のみアクセス可）。 */
const TEMP_DIR_MODE = 0o700

/**
 * プロジェクト共有ファイル（S3 上の永続ストレージ）を参照する MCP ツール。
 *
 * エージェント実行マシンのローカルFS（Claude Code の Read/Glob 等）とは別で、
 * プロジェクト共通の資産（証明書・設定テンプレート・仕様書等）を扱う。
 * **読み取り専用**で、変更操作は Web の管理者UI に限定する。
 *
 * テナント/プロジェクトはエージェントトークンからサーバー側が解決するため、
 * 他プロジェクトのファイルは構造上参照できない。
 */
export function registerProjectFilesTools(
  server: McpServer,
  apiClient: ApiClient,
): void {
  server.tool(
    "list_project_files",
    "List files in the project shared folder (persistent storage shared across the project, " +
      "separate from the local filesystem). Use this to discover shared assets such as " +
      "certificates, configuration templates, and specification documents.",
    {
      path: z
        .string()
        .optional()
        .describe(
          "Folder path relative to the shared folder root. Omit to list the root.",
        ),
    },
    async ({ path: folderPath }) =>
      withMcpErrorHandling(async () => {
        const entries = await apiClient.listProjectFiles(folderPath);
        return mcpJsonResponse(
          entries.map((entry) => ({
            name: entry.name,
            path: entry.path,
            type: entry.type,
            size: entry.size,
            modified: entry.modified,
          })),
        );
      }),
  );

  server.tool(
    "read_project_file",
    "Read a file from the project shared folder. Pass the `path` returned by " +
      "list_project_files. Text files are returned inline, images as image content, " +
      "and other binaries are written to a temp file whose path is returned.",
    {
      path: z.string().describe("File path relative to the shared folder root"),
    },
    async ({ path: filePath }) =>
      withMcpErrorHandling(async () => {
        const { downloadUrl, filename, contentType } =
          await apiClient.getProjectFileDownloadUrl(filePath);

        if (isImageMime(contentType)) {
          const response = await axios.get(downloadUrl, {
            responseType: "arraybuffer",
            timeout: CONVERSATION_FILE_DOWNLOAD_TIMEOUT_MS,
            maxContentLength: MAX_READ_BYTES,
            maxBodyLength: MAX_READ_BYTES,
          });
          const base64 = Buffer.from(response.data as ArrayBuffer).toString(
            "base64",
          );
          return mcpImageResponse(base64, contentType);
        }

        if (isTextMime(contentType)) {
          const response = await axios.get(downloadUrl, {
            responseType: "text",
            timeout: CONVERSATION_FILE_DOWNLOAD_TIMEOUT_MS,
            maxContentLength: MAX_READ_BYTES,
            maxBodyLength: MAX_READ_BYTES,
          });
          return mcpTextResponse(`File: ${filename}\n\n${response.data}`);
        }

        // バイナリ（xlsx/pdf/zip 等）は一時ファイルへ落とし、Claude Code が
        // Bash ツールで扱えるようローカルパスを返す（read_conversation_file と同方式）。
        const response = await axios.get(downloadUrl, {
          responseType: "arraybuffer",
          timeout: CONVERSATION_BINARY_DOWNLOAD_TIMEOUT_MS,
          maxContentLength: MAX_READ_BYTES,
          maxBodyLength: MAX_READ_BYTES,
        });
        // 共有ファイルは証明書・鍵等の機密を含み得るため、同一ホストの他ユーザーから
        // 読めないよう所有者のみアクセス可の権限で作る（既定の umask では 0755/0644）。
        const tmpDir = path.join(os.tmpdir(), "ai-support-agent-project-files");
        fs.mkdirSync(tmpDir, { recursive: true, mode: TEMP_DIR_MODE });
        // 既存ディレクトリには mkdirSync の mode が効かないため明示的に設定する。
        fs.chmodSync(tmpDir, TEMP_DIR_MODE);
        // ファイル名はサーバー由来だが、一時ディレクトリ外への書き出しを防ぐため
        // basename に落としてから使う（パストラバーサル対策）。
        const safeFilename = path.basename(filename);
        const uniqueId = crypto.randomUUID().slice(0, 8);
        const tmpFilePath = path.join(tmpDir, `${uniqueId}_${safeFilename}`);
        fs.writeFileSync(
          tmpFilePath,
          Buffer.from(response.data as ArrayBuffer),
          { mode: TEMP_FILE_MODE },
        );

        return mcpTextResponse(
          `File: ${filename} (${contentType})\n` +
            `Saved to: ${tmpFilePath}\n` +
            "Use Bash/Read tools on this path to inspect the contents.",
        );
      }),
  );
}
