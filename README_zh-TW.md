<div align="right">
  <a title="English" href="README.md"><img src="https://img.shields.io/badge/-English-545759?style=for-the-badge" alt="English"></a>
  <a title="繁體中文" href="README_zh-TW.md"><img src="https://img.shields.io/badge/-%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87-1F6FEB?style=for-the-badge" alt="繁體中文"></a>
</div>

# 📋 [Net Clipboard](https://github.com/Naoar1/netclipboard)

一個安全的 Cloudflare 架構跨裝置臨時剪貼簿，以 6 位數代碼傳送文字/圖片，支援點對點加密，並自動在 15 分鐘後刪除內容。

> 範例入口：https://clip.us.ci/

## 💡 使用場景
- **跨裝置接力**：手機、電腦、平板之間，無縫互傳文字、網址。

- **隱私資料傳遞**：利用端對端加密，安全轉傳密文或憑證。

- **臨時檔案分享**：無需安裝 APP 或加好友，會議或教室中，透過代碼即時分發圖片給所有人。

## 📌 常見問題
### 專案架構
- 基於 Cloudflare Workers、Durable Objects 與 R2 構建的無伺服器架構。

- 由於平台免費額度 (Free Tier) 相當充裕，本專案足以應付小型團隊的日常使用需求。

### 用量與限制
- 免費方案 Cloudflare 提供 R2 儲存空間 **10 GB/月** 以及 Durable Objects 額度 **13,000 GB-秒/日**。

- 考量正常圖片占用與高頻需求，預設單次圖片上傳最大 **20 MB**。

### 隱私與安全
- 支援端對端加密 (E2EE)，內容在瀏覽器端使用 PBKDF2 與 AES-GCM 加密後才上傳。

- 遠端伺服器僅儲存加密後的資料，無法窺探您的原始文字或圖片。

- 所有內容預設僅保留 15 分鐘，過期自動從 Durable Object 與 R2 存儲桶中銷毀，不留數位痕跡。

## 🚀 部屬方式
### GitHub Actions

1. 需要自備 Cloudflare 帳戶，將專案 Fork 到您的 GitHub 帳號。  

2. 修改設定：編輯 wrangler.toml，修改 routes 為您的網域，或移除此段落。  

    ```toml
    [[routes]]  

    pattern = "YOUR_DOMAIN"  

    custom_domain = true

    ```

3. 在 Cloudflare 手動建立 R2 Bucket，名稱需與設定檔一致（預設為 netclipboard）。  

4. 在 Cloudflare 建立一個 API Token（選擇 Workers 範本），確認具備 Workers（編輯 / 部署）、 R2（讀寫）  

5. 設定 Secrets：在 Repo 的 Settings > Secrets > Actions 新增以下變數：  

    ```txt
    CLOUDFLARE_API_TOKEN　// 需具備 Workers 與 R2 讀寫權限。  

    CLOUDFLARE_ACCOUNT_ID // 您的帳戶 ID。
    ```

6. 進入 GitHub Actions 重新執行部署。  


## ⚙️ 關於專案
本工具部分內容由 AI 協助開發，並在發布前完成人工審閱與功能驗證，若發現錯誤或安全疑慮，請提交 Issue 回報。  

如果你喜歡這個項目，請在右上角給⭐鼓勵。
