# 🛜 WiFiWatch • MTN 5G ODU & Broadband Data Usage Tracker

A sleek, automated daily data usage tracker and analytics dashboard tailored for **MTN 5G ODU (ZLT X17U)** and **MTN FibreX** broadband routers.

**Live Dashboard:** [https://wifi-watch.vercel.app/](https://wifi-watch.vercel.app/)  
**Latest Extension Release:** [Download WiFiWatch Chrome Extension v1.0.0](https://github.com/sagenoya/mtn-data-tracker/releases/latest)

---

## ✨ Key Features

- **⚡ 1-Click Router Sync:** Directly extract SIM carrier daily usage notifications from your router's SMS inbox.
- **🛡️ 100% Reset-Safe Persistence:** Automatic merge protection ensures previous records are never overwritten or lost when routers are reset or SMS inboxes are cleared.
- **🔍 Gap Detection & 1-Click Repair:** Automatically detects missing calendar dates in your billing cycle and lets you fill gaps as 0.00 GB (offline) or estimated daily averages.
- **💾 Full JSON Backup & Restore:** Export complete snapshot backups to keep offline or transfer between devices.
- **📊 Daily Consumption & Burn Rate Analytics:** Automatically calculates month-to-date totals, average daily burn rates, remaining budget caps, and projected end-of-month totals.
- **📈 Interactive Trend Charts:** Visualizes your daily usage history with minimal bar charts.
- **🧩 Chrome Extension Bridge:** Bypasses browser HTTPS mixed-content restrictions to connect live cloud dashboards with local router gateways (`192.168.0.1` & `192.168.1.1`).
- **📥 Universal SMS Importer & Manual Entry:** Easily paste raw SMS text directly or log custom usage dates.
- **📄 Instant CSV Export:** Download comprehensive usage history spreadsheets in 1 click.

---

## 🚀 How to Install & Use the Chrome Extension

To sync your router directly from the live web dashboard ([wifi-watch.vercel.app](https://wifi-watch.vercel.app/)), install the lightweight companion Chrome Extension:

### Step 1: Download the Extension
1. Go to the [Releases Page](https://github.com/sagenoya/mtn-data-tracker/releases/latest).
2. Download **`wifiwatch-extension.zip`** and extract/unzip it on your computer.

### Step 2: Load the Extension into Chrome
1. Open Google Chrome (or Brave, Microsoft Edge, Arc).
2. Type `chrome://extensions` in your address bar and press Enter.
3. Turn **ON** the **Developer mode** toggle in the top-right corner.
4. Click the **Load unpacked** button in the top-left.
5. Select the extracted **`extension`** folder.

### Step 3: Sync Your Router
1. Visit **[https://wifi-watch.vercel.app/](https://wifi-watch.vercel.app/)**.
2. Click **Sync Router** in the top header.
3. Select your device gateway:
   - `192.168.0.1` (MTN 5G ODU / ZLT X17U Router)
   - `192.168.1.1` (MTN FibreX / Indoor Gateway)
4. Enter your router admin password (default: `admin`) and click **Sync Router**.
5. Your daily usage logs, burn rate, and consumption charts will populate instantly!

---

## 📱 Alternative: Zero-Install Mobile / Web Mode

If you are on an iPhone, Android, or do not want to install the extension:

1. Open **[https://wifi-watch.vercel.app/](https://wifi-watch.vercel.app/)** on any browser.
2. Click **+ Import SMS Text** in the header.
3. Copy and paste your MTN daily usage SMS notifications (e.g. `Y'ello, your data usage for 12-08-2026 is 19.56GB`).
4. Click **Parse & Import**. The dashboard will automatically calculate your metrics.

---

## 💻 Local Development (Optional)

If you prefer to run the Node.js backend server locally on your machine:

```bash
# 1. Clone the repository
git clone https://github.com/sagenoya/mtn-data-tracker.git
cd mtn-data-tracker

# 2. Install dependencies
npm install

# 3. Start local server
npm start
```

Open `http://localhost:3000` in your browser. When running locally, automated background sync executes daily at **7:00 AM**.

---

## 🔒 Security & Privacy

- **Zero Cloud Transmission of Credentials:** Your router password and SMS contents are processed locally in your browser/extension and never sent to any external server.
- **Isolated Storage:** Each visitor on Vercel receives their own private sandbox stored exclusively in their device's local browser memory.

---

## 📄 License
MIT License &copy; 2026 Sagenoya. All rights reserved.
