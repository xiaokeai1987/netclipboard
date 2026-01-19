<div align="right">
  <a title="English" href="README.md"><img src="https://img.shields.io/badge/-English-545759?style=for-the-badge" alt="English"></a>
  <a title="繁體中文" href="README_zh-TW.md"><img src="https://img.shields.io/badge/-%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87-1F6FEB?style=for-the-badge" alt="繁體中文"></a>
</div>

# 📋 [Net Clipboard](https://github.com/Naoar1/netclipboard)

A secure, serverless cross-device temporary clipboard built on Cloudflare.  

Transfer text/images via 6-digit codes with end-to-end encryption support.  

Content is automatically deleted after 15 minutes.

> Demo: https://clip.us.ci/

## 💡 Use Cases
- **Cross-Device Handoff**: Seamlessly transfer text and URLs between phones, computers, and tablets.

- **Secure Data Transfer**: Use end-to-end encryption to safely transmit passwords or credentials.

- **Temp File Sharing**: Instantly share images in a meeting or classroom via a code, without installing apps or adding friends.

## 📌 FAQ
### Architecture
- Serverless architecture built on Cloudflare Workers, Durable Objects, and R2.

- Due to the generous platform Free Tier limits, this project is sufficient for the daily needs of small teams.

### Usage & Limits
- The Cloudflare Free Tier provides **10 GB/month** of R2 storage and **13,000 GB-seconds/day** for Durable Objects.

- Considering standard image sizes and high-frequency needs, the default maximum upload size per image is **20 MB**.

### Privacy & Security
- Supports End-to-End Encryption (E2EE). Content is encrypted client-side using PBKDF2 and AES-GCM before upload.

- The remote server only stores encrypted data and cannot view your original text or images.

- All content is retained for only 15 minutes by default, after which it is automatically destroyed, leaving no digital trace.

## 🚀 Deployment
### GitHub Actions

1. You need a Cloudflare account. Fork this project to your GitHub account.  

2. Edit `wrangler.toml`, change `routes` to your domain, or remove this section.  

   ```toml
   [[routes]]
   
   pattern = "YOUR_DOMAIN"
   
   custom_domain = true
   ```
   
3. Manually create an R2 Bucket in Cloudflare. The name must match the configuration file (default is netclipboard).  

4. Create an API Token in Cloudflare (select the "Workers" template). Ensure it has permissions for Workers and R2 .  

5. Add the following variables in the Repo's Settings > Secrets > Actions:

    ```txt
    CLOUDFLARE_API_TOKEN　// Required Workers (Edit / Deploy) and R2 (Read / Write) permissions.  

    CLOUDFLARE_ACCOUNT_ID // Your account ID。
    ```

6. Go to GitHub Actions and re-run the deployment.  

## ⚙️ About
Parts of this tool were developed with AI assistance and underwent manual review and functional verification before release.  

If you find errors or security concerns, please submit an Issue.  

Please give it a ⭐ in the top right corner if you like this project.
