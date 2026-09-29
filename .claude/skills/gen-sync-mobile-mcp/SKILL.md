---
name: gen-sync-mobile-mcp
description: |
  當使用者要把上游 mobile-mcp（https://github.com/mobile-next/mobile-mcp）的最新程式碼
  同步進本 repository 時使用。可指定上游 tag（如 1.0.5），未指定則同步 upstream/main。
  觸發條件：gen-sync-mobile-mcp [tag]、同步 mobile-mcp、更新 mobile-mcp 上游、sync upstream mobile-mcp
allow-tools:
  - Bash
---

# Sync mobile-mcp Upstream

本 repo 以 **upstream remote + merge** 追蹤 mobile-mcp：上游程式碼直接放在 repo 根目錄，保留上游歷史，本地客製修改靠 merge 與上游合流。

**絕不 push、絕不 `-X theirs`/`-X ours` 整批解衝突、絕不直接在 `main` 上 merge。**

## 1. 前置檢查

```bash
git status --porcelain          # 必須為空；不乾淨就停下，請使用者先處理
git switch main && git pull --ff-only origin main
```

## 2. 設定並抓取 upstream

```bash
git remote get-url upstream 2>/dev/null \
  || git remote add upstream https://github.com/mobile-next/mobile-mcp.git
git remote set-url --push upstream DISABLED   # 防止誤推上游
```

- 未指定 tag：`git fetch --no-tags upstream main`，目標 `TARGET=upstream/main`
- 指定 tag：`git fetch --no-tags upstream "refs/tags/<tag>:refs/upstream-tags/<tag>"`，目標 `TARGET=refs/upstream-tags/<tag>`

一律 `--no-tags`：上游 tag（`1.0.5` 這類）不能混進本 repo 自己的 release tag。

若 `git merge-base --is-ancestor $TARGET HEAD` 成立 → 已是最新，回報後結束。

## 3. 建立同步分支

```bash
LABEL=<tag 或 upstream/main 的 short sha>
git switch -c chore/$(date +%Y%m)/sync-mobile-mcp-$LABEL
git log --oneline HEAD..$TARGET | head -50   # 記下本次帶進的上游 commits
```

## 4. Merge

```bash
if git merge-base HEAD $TARGET >/dev/null; then
  git merge --no-ff --no-commit $TARGET
else
  git merge --no-ff --no-commit --allow-unrelated-histories $TARGET   # 首次同步
fi
```

## 5. 解衝突

| 檔案 | 處理 |
|---|---|
| `README.md` | 保留本 repo 版本：`git checkout --ours README.md` |
| `LICENSE` | 保留本 repo 版本；上游 Apache-2.0 另存：`git show $TARGET:LICENSE > LICENSE-mobile-mcp` 並 `git add`（Apache-2.0 §4 要求附上授權副本） |
| 其他任何衝突 | **停下**，列出檔案與雙方差異摘要，詢問使用者。本地客製碼不可自行丟棄 |

解完 `git diff --name-only --diff-filter=U` 必須為空。

## 6. 驗證

```bash
npm ci && npm run build && npm run lint
```

`npm test`（playwright）需要實體裝置／模擬器，只在使用者要求時跑。驗證失敗 → 回報錯誤輸出，不 commit。

## 7. Commit

```bash
git commit -m "chore(upstream): sync mobile-mcp to $LABEL" \
  -m "Merge mobile-next/mobile-mcp <完整 sha>. Upstream commits: <N>."
```

## 8. 回報

- 分支名稱、上游版本（tag / sha）、帶進的上游 commit 數
- 衝突與處理方式
- 驗證結果
- 提醒：上游附帶 `.github/workflows`、`.husky`（`npm ci` 會經 `prepare` 安裝 git hooks），若不想在本 repo 生效需另行處理

不自動 push、不開 PR；使用者要求時再交給 gen-pr。

## 常見錯誤

| 錯誤 | 正確 |
|---|---|
| `git fetch upstream`（帶 tags） | `--no-tags`，上游 tag 走 `refs/upstream-tags/` |
| 在 `main` 直接 merge | 先開同步分支 |
| `-X theirs` 一次解掉所有衝突 | 只有 README/LICENSE 有固定規則，其餘問使用者 |
| 刪掉上游 LICENSE | 另存為 `LICENSE-mobile-mcp` |
