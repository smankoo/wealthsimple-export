// Wealthsimple Transaction Exporter - Content Script
// Injects export buttons into the Wealthsimple activity pages

(function () {
  "use strict";

  const EXPORT_BTN_ID = "ws-export-csv";
  const GRAPHQL_URL = "https://my.wealthsimple.com/graphql";

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  function getOauthCookie() {
    const decoded = decodeURIComponent(document.cookie).split(";");
    for (const kv of decoded) {
      if (kv.indexOf("_oauth2_access_v2") !== -1) {
        const [, val] = kv.split("=");
        return JSON.parse(val);
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // GraphQL helpers
  // ---------------------------------------------------------------------------

  async function gqlPost(operationName, query, variables) {
    const oauth = getOauthCookie();
    if (!oauth) throw new Error("Not logged in — no oauth cookie found");

    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${oauth.access_token}`,
      },
      body: JSON.stringify({ operationName, query, variables }),
    });

    if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const ACTIVITY_FRAGMENT = `
    fragment Activity on ActivityFeedItem {
      accountId
      externalCanonicalId
      amount
      amountSign
      occurredAt
      type
      subType
      eTransferEmail
      eTransferName
      assetSymbol
      assetQuantity
      aftOriginatorName
      aftTransactionCategory
      spendMerchant
      billPayCompanyName
      billPayPayeeNickname
      opposingAccountId
      p2pHandle
      currency
      status
    }
  `;

  const FETCH_ACTIVITIES = `
    query FetchActivityFeedItems(
      $first: Int
      $cursor: Cursor
      $condition: ActivityCondition
      $orderBy: [ActivitiesOrderBy!] = OCCURRED_AT_DESC
    ) {
      activityFeedItems(
        first: $first
        after: $cursor
        condition: $condition
        orderBy: $orderBy
      ) {
        edges { node { ...Activity } }
        pageInfo { hasNextPage endCursor }
      }
    }
    ${ACTIVITY_FRAGMENT}
  `;

  const FETCH_ACCOUNTS = `
    query FetchAllAccountFinancials($identityId: ID!, $pageSize: Int = 25) {
      identity(id: $identityId) {
        accounts(filter: {}, first: $pageSize) {
          edges {
            node { id unifiedAccountType nickname }
          }
        }
      }
    }
  `;


  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function fetchAccounts() {
    const oauth = getOauthCookie();
    const resp = await gqlPost("FetchAllAccountFinancials", FETCH_ACCOUNTS, {
      identityId: oauth.identity_canonical_id,
      pageSize: 25,
    });
    return resp.data.identity.accounts.edges.map((e) => {
      const n = e.node;
      let nickname = n.nickname;
      if (!nickname) {
        if (n.unifiedAccountType === "CASH") nickname = "Cash";
        else if (n.unifiedAccountType === "CREDIT_CARD") nickname = "Credit Card";
        else nickname = n.unifiedAccountType;
      }
      return { id: n.id, nickname };
    });
  }

  async function fetchAllTransactions(accountIds, startDate) {
    const transactions = [];
    let hasNextPage = true;
    let cursor = undefined;

    while (hasNextPage) {
      const resp = await gqlPost("FetchActivityFeedItems", FETCH_ACTIVITIES, {
        first: 100,
        cursor,
        condition: {
          startDate,
          accountIds,
          unifiedStatuses: ["COMPLETED"],
        },
      });

      const items = resp.data.activityFeedItems;
      hasNextPage = items.pageInfo.hasNextPage;
      cursor = items.pageInfo.endCursor;
      transactions.push(...items.edges.map((e) => e.node));
    }

    return transactions;
  }

  // ---------------------------------------------------------------------------
  // CSV generation
  // ---------------------------------------------------------------------------

  function describeTransaction(t, accountNicknames) {
    const type = t.subType ? `${t.type}/${t.subType}` : t.type;

    switch (type) {
      case "INTEREST":
      case "INTEREST/FPL_INTEREST":
        return { payee: "Wealthsimple", notes: "Interest payment" };
      case "DEPOSIT/E_TRANSFER":
        return { payee: t.eTransferName || t.eTransferEmail || "e-Transfer", notes: `Interac e-Transfer from ${t.eTransferName || t.eTransferEmail}` };
      case "WITHDRAWAL/E_TRANSFER":
        return { payee: t.eTransferName || t.eTransferEmail || "e-Transfer", notes: `Interac e-Transfer to ${t.eTransferName || t.eTransferEmail}` };
      case "CREDIT_CARD/PURCHASE":
        return { payee: t.spendMerchant || "Unknown merchant", notes: "Credit card purchase" };
      case "CREDIT_CARD/REFUND":
        return { payee: t.spendMerchant || "Refund", notes: "Credit card refund" };
      case "CREDIT_CARD/PAYMENT":
      case "CREDIT_CARD_PAYMENT":
        return { payee: "Wealthsimple Credit Card", notes: "Credit card payment" };
      case "REIMBURSEMENT/CASHBACK":
        return { payee: "Wealthsimple", notes: "Cashback reward" };
      case "REIMBURSEMENT/ATM":
        return { payee: "Wealthsimple", notes: "ATM fee reimbursement" };
      case "DEPOSIT/AFT":
        return { payee: t.aftOriginatorName || "Direct deposit", notes: `Direct deposit from ${t.aftOriginatorName || "employer"}` };
      case "WITHDRAWAL/AFT":
        return { payee: t.aftOriginatorName || "Withdrawal", notes: `Withdrawal to ${t.aftOriginatorName || "external"}` };
      case "DEPOSIT/EFT":
        return { payee: "EFT Deposit", notes: "Electronic funds transfer in" };
      case "WITHDRAWAL/EFT":
        return { payee: "EFT Withdrawal", notes: "Electronic funds transfer out" };
      case "INTERNAL_TRANSFER/SOURCE":
        return { payee: `Transfer to ${accountNicknames[t.opposingAccountId] || "Wealthsimple"}`, notes: "Internal transfer out" };
      case "INTERNAL_TRANSFER/DESTINATION":
        return { payee: `Transfer from ${accountNicknames[t.opposingAccountId] || "Wealthsimple"}`, notes: "Internal transfer in" };
      case "SPEND/PREPAID":
        return { payee: t.spendMerchant || "Prepaid", notes: "Prepaid purchase" };
      case "WITHDRAWAL/BILL_PAY":
        return { payee: t.billPayCompanyName || t.billPayPayeeNickname || "Bill payment", notes: `Bill pay${t.billPayPayeeNickname ? " - " + t.billPayPayeeNickname : ""}` };
      case "P2P_PAYMENT/SEND":
        return { payee: t.p2pHandle || "P2P", notes: "Peer-to-peer payment" };
      default:
        if (type.startsWith("DIY_BUY") || type.startsWith("CRYPTO_BUY")) {
          return { payee: t.assetSymbol || "Buy", notes: `Bought ${t.assetQuantity || ""} ${t.assetSymbol || ""}`.trim() };
        }
        if (type.startsWith("DIY_SELL") || type.startsWith("CRYPTO_SELL")) {
          return { payee: t.assetSymbol || "Sell", notes: `Sold ${t.assetQuantity || ""} ${t.assetSymbol || ""}`.trim() };
        }
        if (type.startsWith("DIVIDEND")) {
          return { payee: t.assetSymbol || "Dividend", notes: `Dividend from ${t.assetSymbol || "investment"}` };
        }
        return { payee: type, notes: type };
    }
  }

  function csvEscape(val) {
    const s = String(val ?? "");
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function transactionsToCsv(transactions, accountNicknames) {
    // YNAB format: Date, Payee, Memo, Amount
    // Date: YYYY-MM-DD, Amount: signed (negative = outflow, positive = inflow)
    const header = "Date,Payee,Memo,Amount";
    const rows = transactions.map((t) => {
      const date = new Date(t.occurredAt);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const { payee, notes } = describeTransaction(t, accountNicknames);
      const amount = t.amountSign === "negative" ? `-${t.amount}` : t.amount;
      return [dateStr, payee, notes, amount].map(csvEscape).join(",");
    });
    return "\uFEFF" + [header, ...rows].join("\n");
  }

  function downloadCsv(csvText, filename) {
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------------------
  // UI — Export button bar
  // ---------------------------------------------------------------------------

  function createButtonStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #${EXPORT_BTN_ID} {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 0;
      }
      #${EXPORT_BTN_ID} .ws-export-label {
        font-size: 13px;
        color: #666;
      }
      #${EXPORT_BTN_ID} button {
        background: #222;
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 6px 14px;
        font-size: 13px;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      #${EXPORT_BTN_ID} button:hover {
        opacity: 0.8;
      }
      #${EXPORT_BTN_ID} button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      @media (prefers-color-scheme: dark) {
        #${EXPORT_BTN_ID} .ws-export-label { color: #aaa; }
        #${EXPORT_BTN_ID} button { background: #fff; color: #222; }
      }
    `;
    document.head.appendChild(style);
  }

  async function handleExport(button, startDate) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Exporting...";

    try {
      const accounts = await fetchAccounts();
      const accountNicknames = accounts.reduce((m, a) => { m[a.id] = a.nickname; return m; }, {});

      // Determine which accounts to export based on current page
      let accountIds;
      const pathParts = window.location.pathname.split("/");
      if (pathParts.length === 4 && pathParts[2] === "account-details") {
        accountIds = [pathParts[3]];
      } else {
        const params = new URLSearchParams(window.location.search);
        const idsParam = params.get("account_ids");
        accountIds = idsParam ? idsParam.split(",") : accounts.map((a) => a.id);
      }

      const transactions = await fetchAllTransactions(accountIds, startDate);

      if (transactions.length === 0) {
        button.textContent = "No transactions";
        setTimeout(() => { button.textContent = originalText; button.disabled = false; }, 2000);
        return;
      }

      const csv = transactionsToCsv(transactions, accountNicknames);
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      downloadCsv(csv, `wealthsimple-transactions-${dateStr}.csv`);

      button.textContent = `Done (${transactions.length})`;
      setTimeout(() => { button.textContent = originalText; button.disabled = false; }, 2000);
    } catch (err) {
      console.error("[ws-export]", err);
      button.textContent = "Error";
      setTimeout(() => { button.textContent = originalText; button.disabled = false; }, 3000);
    }
  }

  function buildButtonBar() {
    const bar = document.createElement("div");
    bar.id = EXPORT_BTN_ID;

    const label = document.createElement("span");
    label.className = "ws-export-label";
    label.textContent = "Export CSV:";
    bar.appendChild(label);

    const now = new Date();
    const ranges = [
      { text: "This Month", date: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() },
      { text: "Last 3 Months", date: new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString() },
      { text: "All Time", date: null },
    ];

    for (const range of ranges) {
      const btn = document.createElement("button");
      btn.textContent = range.text;
      btn.addEventListener("click", () => handleExport(btn, range.date));
      bar.appendChild(btn);
    }

    return bar;
  }

  // ---------------------------------------------------------------------------
  // Page detection & injection
  // ---------------------------------------------------------------------------

  function getAnchorElement() {
    const pathParts = window.location.pathname.split("/");

    // Account details page: /app/account-details/<id>
    if (pathParts.length === 4 && pathParts[2] === "account-details") {
      // Find the "Activity" h2 heading on the account page
      const headings = document.querySelectorAll("h2");
      for (const h of headings) {
        if (h.textContent.trim() === "Activity") return h;
      }
      return null;
    }

    // Activity page: /app/activity
    if (pathParts.length === 3 && pathParts[2] === "activity") {
      const h1s = document.querySelectorAll("h1");
      for (const h1 of h1s) {
        if (h1.textContent === "Activity") return h1;
      }
    }

    return null;
  }

  function injectButtons() {
    if (document.getElementById(EXPORT_BTN_ID)) return;

    const anchor = getAnchorElement();
    if (!anchor) return;

    const bar = buildButtonBar();
    anchor.after(bar);
    console.log("[ws-export] Export buttons injected");
  }

  // ---------------------------------------------------------------------------
  // Init — watch for SPA navigation / re-renders
  // ---------------------------------------------------------------------------

  createButtonStyles();

  const observer = new MutationObserver(() => injectButtons());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("load", () => injectButtons());
})();
