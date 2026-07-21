-- ===== 基本設定 =====
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- コンテナには zsh が入っていないため、実際に存在する bash を使う
vim.opt.shell = "/bin/bash"
vim.opt.shiftwidth = 4
vim.opt.tabstop = 4
vim.opt.expandtab = true
vim.opt.textwidth = 0
vim.opt.autoindent = true
vim.opt.hlsearch = true
vim.opt.clipboard = "unnamed"
vim.opt.number = true

-- コマンドライン補完: 最初のTabで最長共通部分まで補完しつつ候補メニュー表示、
-- 以降のTabで候補を巡回する（set wildmenu / wildmode=longest:full,full 相当）
vim.opt.wildmenu = true
vim.opt.wildmode = "longest:full,full"

-- 見やすさのため既定の配色から変更（追加プラグイン不要の同梱テーマ）
vim.cmd.colorscheme("habamax")

-- ===== lazy.nvim（プラグインマネージャ）のブートストラップ =====
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local lazyrepo = "https://github.com/folke/lazy.nvim.git"
  local out = vim.fn.system({
    "git", "clone", "--filter=blob:none", "--branch=stable", lazyrepo, lazypath,
  })
  if vim.v.shell_error ~= 0 then
    vim.api.nvim_echo({
      { "lazy.nvim のクローンに失敗しました:\n", "ErrorMsg" },
      { out, "WarningMsg" },
    }, true, {})
    vim.fn.getchar()
    os.exit(1)
  end
end
vim.opt.rtp:prepend(lazypath)

-- ===== プラグイン定義 =====
require("lazy").setup({
  -- Powerline風のファイル情報ステータスライン
  {
    "nvim-lualine/lualine.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    event = "VeryLazy",
    opts = {
      options = {
        icons_enabled = true,
        theme = "auto",
        component_separators = { left = "", right = "" },
        section_separators = { left = "", right = "" },
        globalstatus = true,
      },
      sections = {
        lualine_a = { "mode" },
        lualine_b = {
          "branch",
          {
            "diff",
            symbols = { added = "+", modified = "~", removed = "-" },
          },
        },
        lualine_c = {
          {
            "filename",
            path = 1,
            symbols = {
              modified = " [+]",
              readonly = " [RO]",
              unnamed = "[No Name]",
              newfile = "[New]",
            },
          },
        },
        lualine_x = { "filesize", "encoding", "fileformat", "filetype" },
        lualine_y = { "progress" },
        lualine_z = { "location" },
      },
      inactive_sections = {
        lualine_a = {},
        lualine_b = {},
        lualine_c = { { "filename", path = 1 } },
        lualine_x = { "filetype" },
        lualine_y = {},
        lualine_z = { "location" },
      },
    },
  },
  -- fzfを使ったファイル・全文・バッファ・ヘルプ検索
  {
    "ibhagwan/fzf-lua",
    dependencies = { "nvim-mini/mini.icons" },
    opts = {},
    keys = {
      { "<leader>f", function() require("fzf-lua").files() end, desc = "Find files" },
      { "<leader>g", function() require("fzf-lua").live_grep() end, desc = "Live grep" },
      { "<leader>b", function() require("fzf-lua").buffers() end, desc = "Find buffers" },
      { "<leader>h", function() require("fzf-lua").helptags() end, desc = "Find help" },
    },
  },
  -- Markdown を解析する土台（新 main ブランチ / 新API）
  -- main は無タグで随時 Neovim/tree-sitter CLI の要求バージョンが上がりうるため、
  -- 同梱の Neovim（v0.12.4 固定）で動作確認済みのコミットに固定する。
  {
    "nvim-treesitter/nvim-treesitter",
    branch = "main",
    commit = "7248feaca45e4d944591497964bc19afa89ad1c6",
    lazy = false,
    build = ":TSUpdate",
    config = function()
      -- 必要なパーサを導入（既に入っていれば何もしない）
      require("nvim-treesitter").install({ "markdown", "markdown_inline" })
      -- markdown を開いたら treesitter を有効化
      vim.api.nvim_create_autocmd("FileType", {
        pattern = { "markdown" },
        callback = function()
          pcall(vim.treesitter.start)
        end,
      })
    end,
  },
  -- Markdown をバッファ内で装飾表示
  {
    "MeanderingProgrammer/render-markdown.nvim",
    dependencies = {
      { "nvim-treesitter/nvim-treesitter", branch = "main" },
      "nvim-mini/mini.icons",
    },
    ft = { "markdown" },
    opts = {
      heading = { sign = false },
      code = { sign = false, width = "block", right_pad = 1 },
      checkbox = { enabled = true },
    },
  },
  -- CSV/TSV を列整形して表示（非破壊・区切り自動判定）。値の編集はこれが土台。
  {
    "hat0uma/csvview.nvim",
    ft = { "csv", "tsv" },
    cmd = { "CsvViewEnable", "CsvViewDisable", "CsvViewToggle" },
    opts = {
      view = {
        display_mode = "border", -- 列区切りを罫線風に表示
      },
      -- csvview 有効時のみ効くフィールド移動キー（Excel風ナビゲーション）
      keymaps = {
        -- フィールド選択のテキストオブジェクト
        textobject_field_inner = { "if", mode = { "o", "x" } },
        textobject_field_outer = { "af", mode = { "o", "x" } },
        -- Tab/S-Tab で左右のフィールド、Enter/S-Enter で上下の行へ移動
        jump_next_field_end = { "<Tab>", mode = { "n", "v" } },
        jump_prev_field_end = { "<S-Tab>", mode = { "n", "v" } },
        jump_next_row = { "<Enter>", mode = { "n", "v" } },
        jump_prev_row = { "<S-Enter>", mode = { "n", "v" } },
      },
    },
    keys = {
      { "<leader>cv", "<cmd>CsvViewToggle<cr>", desc = "CSV view toggle" },
    },
  },
  -- 列ごとの虹色ハイライト + RBQL(SQLライクな絞り込み/集計)
  {
    "mechatroner/rainbow_csv",
    ft = { "csv", "tsv" },
  },
})
