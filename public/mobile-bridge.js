// BusyDays mobile bridge. Loaded by every page but inert in browsers — it only
// activates inside the native Capacitor shell (the iOS/Android app), where it:
//   1. Routes Google sign-in through the system browser (Google blocks OAuth in
//      webviews) and completes login from the busydays://auth deep link.
//   2. Replaces web-push with native FCM push registration.
//   3. Navigates to a notification's target URL when the user taps it.
(function () {
  var cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return;

  var plugins = cap.Plugins || {};
  var App = plugins.App;
  var Browser = plugins.Browser;
  var Push = plugins.PushNotifications;

  document.documentElement.classList.add("native-app");

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      credentials: "same-origin",
    });
  }

  // ── 1. Google sign-in via system browser ──────────────────────────────────
  // Intercept every /auth/google* link (login, business-profile consent) and
  // open it externally with ?mobile=1 so the server finishes with a deep link.
  document.addEventListener(
    "click",
    function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest("a[href^='/auth/google']") : null;
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      var url = new URL(anchor.getAttribute("href"), window.location.origin);
      url.searchParams.set("mobile", "1");
      if (Browser && Browser.open) {
        Browser.open({ url: url.toString() });
      } else {
        window.open(url.toString(), "_system");
      }
    },
    true,
  );

  // Deep-link return: busydays://auth?ott=... → exchange for a session cookie
  // inside this webview, then reload into the logged-in app.
  if (App && App.addListener) {
    App.addListener("appUrlOpen", function (event) {
      var ott = null;
      try {
        ott = new URL(event.url).searchParams.get("ott");
      } catch (e) {
        return;
      }
      if (!ott) return;
      if (Browser && Browser.close) Browser.close().catch(function () {});
      postJson("/api/auth/mobile/exchange", { ott: ott })
        .then(function (res) {
          if (res.ok) {
            window.location.replace("/");
          } else {
            return res.json().then(function (data) {
              alert((data && data.error) || "Sign-in expired — please try again.");
            });
          }
        })
        .catch(function () {
          alert("Couldn't complete sign-in. Check your connection and try again.");
        });
    });
  }

  // ── 2 & 3. Native push ─────────────────────────────────────────────────────
  var registrationListenerAdded = false;
  function ensurePushListeners() {
    if (registrationListenerAdded || !Push) return;
    registrationListenerAdded = true;
    Push.addListener("registration", function (token) {
      postJson("/api/push/register-device", {
        token: token.value,
        platform: cap.getPlatform(),
      }).catch(function () {});
    });
    Push.addListener("pushNotificationActionPerformed", function (action) {
      var url =
        action && action.notification && action.notification.data && action.notification.data.url;
      // Same-origin paths only — a notification must not be able to steer the
      // webview to an arbitrary external site.
      if (typeof url === "string" && url.charAt(0) === "/") window.location.href = url;
    });
  }
  ensurePushListeners();

  function requestAndRegister() {
    return Push.checkPermissions()
      .then(function (perm) {
        if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
          return Push.requestPermissions();
        }
        return perm;
      })
      .then(function (perm) {
        if (perm.receive !== "granted") return false;
        return Push.register().then(function () {
          return true;
        });
      });
  }

  // Take over the notifications panel from the web-push flow. In a native
  // webview PushManager doesn't exist, so the web flow leaves the panel hidden;
  // we show it and wire the button to FCM registration instead.
  function initNativePushPanel() {
    if (!Push) return;
    fetch("/api/push/config", { credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (cfg) {
        if (!cfg || !cfg.fcmEnabled) return;
        var panel = document.getElementById("push-panel");
        var btn = document.getElementById("push-enable-btn");
        if (!panel || !btn) return;
        panel.hidden = false;
        // Clone to strip the web-push click handler attached by the main script.
        var nativeBtn = btn.cloneNode(true);
        btn.replaceWith(nativeBtn);
        nativeBtn.disabled = false;

        Push.checkPermissions().then(function (perm) {
          if (perm.receive === "granted") {
            // Already allowed — re-register silently (FCM tokens rotate).
            Push.register().catch(function () {});
            nativeBtn.textContent = "✓ Notifications are on";
            nativeBtn.disabled = true;
            return;
          }
          nativeBtn.addEventListener("click", function () {
            requestAndRegister().then(function (granted) {
              if (granted) {
                nativeBtn.textContent = "✓ Notifications are on";
                nativeBtn.disabled = true;
              } else {
                var status = document.getElementById("push-status");
                if (status) status.textContent = "Notifications are off — enable them for BusyDays in your phone's Settings.";
              }
            });
          });
        });
      })
      .catch(function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNativePushPanel);
  } else {
    initNativePushPanel();
  }
})();
