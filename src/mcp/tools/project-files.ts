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
          });
          return mcpTextResponse(`File: ${filename}\n\n${response.data}`);
        }

        // バイナリ（xlsx/pdf/zip 等）は一時ファイルへ落とし、Claude Code が
        // Bash ツールで扱えるようローカルパスを返す（read_conversation_file と同方式）。
        const response = await axios.get(downloadUrl, {
          responseType: "arraybuffer",
          timeout: CONVERSATION_BINARY_DOWNLOAD_TIMEOUT_MS,
        });
        const tmpDir = path.join(os.tmpdir(), "ai-support-agent-project-files");
        fs.mkdirSync(tmpDir, { recursive: true });
        // ファイル名はサーバー由来だが、一時ディレクトリ外への書き出しを防ぐため
        // basename に落としてから使う（パストラバーサル対策）。
        const safeFilename = path.basename(filename);
        const uniqueId = crypto.randomUUID().slice(0, 8);
        const tmpFilePath = path.join(tmpDir, `${uniqueId}_${safeFilename}`);
        fs.writeFileSync(
          tmpFilePath,
          Buffer.from(response.data as ArrayBuffer),
        );

        return mcpTextResponse(
          `File: ${filename} (${contentType})\n` +
            `Saved to: ${tmpFilePath}\n` +
            "Use Bash/Read tools on this path to inspect the contents.",
        );
      }),
  );
}
