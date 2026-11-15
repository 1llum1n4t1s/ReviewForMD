// store-assets.steps.mjs — 撮影前の操作（vitrina の steps 拡張点）。
//
// popup は本来「いま開いているタブ」の状態（rfmd:status の応答）でボタンを出し分ける。撮影ではポップアップを
// 拡張ページとして単独で開くため、アクティブタブが対象サイトにならず「対応ページを開いてください」になる。
// そこで popup.js 自身の描画関数 _renderForStatus を、サイト別の status で直接呼んで本物の描画結果を撮る
// （ボタン・文言・Localizer の翻訳は実コードのもの。差し替えるのは「どのサイトにいるか」の状態だけ）。

/** popup を指定 status で描き直し、ビューポートを本文の寸法に合わせ直す。 */
async function renderPopup({ page, cap, locale }, status, { period } = {}) {
  // フッター（共通部品 <kagayoi-support-footer>）は接続時の <html lang> で言語を決める。撮影用の新しい
  // プロファイルでは初回起動で localStorage の控え（cpaUiLanguage）が無く、ブラウザ UI 言語（日本語環境では ja）で
  // 描かれてしまうため、言語を選択済みの状態（控え＋<html lang>）にしてからフッターを作り直す。
  await page.evaluate((loc) => {
    try {
      localStorage.setItem("cpaUiLanguage", loc);
    } catch {
      // 控えが書けなくても撮影は続ける
    }
    document.documentElement.lang = loc.replace("_", "-");
    const footer = document.querySelector("kagayoi-support-footer");
    if (footer) footer.replaceWith(footer.cloneNode(false));
  }, locale);
  await page.evaluate(
    (st, per) => {
      // _renderForStatus は popup.js のトップレベル関数（クラシックスクリプトなのでグローバルに見える）
      // eslint-disable-next-line no-undef
      _renderForStatus(st);
      if (per != null) {
        const select = document.getElementById("teams-period");
        if (select) select.value = per;
      }
    },
    status,
    period ?? null,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const size = await page.evaluate(() => {
    const r = document.body.getBoundingClientRect();
    return { w: Math.ceil(r.width), h: Math.ceil(Math.max(document.body.scrollHeight, r.height)) };
  });
  await page.setViewport({ width: size.w, height: Math.min(size.h, cap.maxHeight ?? 600), deviceScaleFactor: cap.scale ?? 2 });
}

export default {
  // GitHub の PR 詳細ページ: 「MDでダウンロード」「MDコピー」
  "popup-pr": (ctx) => renderPopup(ctx, { siteType: "github", pageType: "detail", available: true, title: "Add retry to the upload queue" }),
  // SharePoint Stream の Teams 会議録画: 「VTTでダウンロード」「VTTコピー」
  "popup-vtt": (ctx) => renderPopup(ctx, { siteType: "sharepoint_teams", pageType: "detail", available: true, title: "" }),
  // Teams チャット: 収集開始月の選択つき（先月からを選んだ状態）
  "popup-teams": (ctx) => renderPopup(ctx, { siteType: "teams_chat", pageType: "detail", available: true, title: "Design team" }, { period: "1" }),
};
