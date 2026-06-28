// BusyDays mobile bridge. Loaded by every page but inert in browsers — it only
// activates inside the native Capacitor shell (the iOS/Android app), where it:
//   1. Signs in via the native Google account-picker (no browser needed); falls
//      back to Chrome Custom Tab OAuth for new users who need Sheets/Calendar.
//   2. Handles the busydays://auth deep-link return from the Custom Tab flow.
//   3. Replaces web-push with native FCM push registration.
//   4. Navigates to a notification's target URL when the user taps it.
(function () {
  var cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return;

  var plugins = cap.Plugins || {};
  var App = plugins.App;
  var Browser = plugins.Browser;
  var Push = plugins.PushNotifications;
  var NativeGoogleSignIn = plugins.NativeGoogleSignIn;

  document.documentElement.classList.add("native-app");

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      credentials: "same-origin",
    });
  }

  // ── 1. Google sign-in ─────────────────────────────────────────────────────
  // For the main /auth/google link, try the native account-picker bottom sheet
  // first. The native flow returns an ID token which the server verifies
  // without any browser. Existing users get signed in immediately; new users
  // (no workspace yet, need Sheets/Calendar scopes) fall through to the Chrome
  // Custom Tab OAuth flow.
  // Non-sign-in Google auth links (business-profile consent, etc.) always go
  // to the Custom Tab since they need specific OAuth scopes.

  var googleClientId = null;  // fetched lazily from /api/push/config
  var googleScopes = [];      // app's OAuth scopes, for the native offline-access request

  function fetchGoogleClientId() {
    if (googleClientId !== null) return Promise.resolve(googleClientId);
    return fetch("/api/push/config", { credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.json() : {}; })
      .then(function (cfg) {
        googleClientId = (cfg && cfg.googleClientId) || "";
        if (cfg && cfg.googleScopes) googleScopes = cfg.googleScopes;
        return googleClientId;
      })
      .catch(function () { return ""; });
  }

  function openOAuthBrowser(href) {
    var url = new URL(href, window.location.origin);
    url.searchParams.set("mobile", "1");
    if (Browser && Browser.open) {
      Browser.open({ url: url.toString() });
    } else {
      window.open(url.toString(), "_system");
    }
  }

  function tryNativeSignIn(href) {
    if (!NativeGoogleSignIn) { openOAuthBrowser(href); return; }
    fetchGoogleClientId()
      .then(function (clientId) {
        if (!clientId) { openOAuthBrowser(href); return; }
        // Ask for offline access + our scopes so the SDK can return a one-time
        // server auth code; first-time users can then be provisioned WITHOUT a
        // browser tab. Plugins that ignore these options simply won't return a
        // serverAuthCode, and we fall back to the Custom Tab exactly as before.
        return NativeGoogleSignIn.signIn({ webClientId: clientId, scopes: googleScopes, offlineAccess: true })
          .then(function (result) {
            return postJson("/api/auth/google/id-token", { idToken: result.idToken })
              .then(function (res) { return res.json(); })
              .then(function (data) {
                if (data.ok) {
                  // Existing user signed in natively — straight into the app.
                  window.location.replace("/");
                  return;
                }
                // New user. If the SDK gave us a server auth code with the right
                // scopes, provision server-side (no tab). Else fall back.
                var code = result.serverAuthCode || result.authCode;
                if (!code) { openOAuthBrowser(href); return; }
                return postJson("/api/auth/google/native-code", { code: code })
                  .then(function (r) { return r.json(); })
                  .then(function (d) {
                    if (d && d.ok) window.location.replace("/");
                    else openOAuthBrowser(href);
                  });
              });
          });
      })
      .catch(function () {
        // User cancelled, Play Services missing, or sign-in error — fall back.
        openOAuthBrowser(href);
      });
  }

  document.addEventListener(
    "click",
    function (event) {
      var anchor = event.target && event.target.closest
        ? event.target.closest("a[href^='/auth/google']")
        : null;
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      var href = anchor.getAttribute("href");
      var isMainSignIn = href === "/auth/google" || href.startsWith("/auth/google?") || href.startsWith("/auth/google#");
      if (isMainSignIn) {
        tryNativeSignIn(href);
      } else {
        // Business-profile and other Google auth links need the full browser flow.
        openOAuthBrowser(href);
      }
    },
    true,
  );

  // Deep-link return from Chrome Custom Tab: busydays://auth?ott=...
  // Chrome Custom Tab issues a 302 to the custom scheme; the OS routes it here.
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

  // ── 2 & 3. Native push ────────────────────────────────────────────────────
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
      // Same-origin paths only — a notification must not steer the webview to
      // an arbitrary external site.
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
        return Push.register().then(function () { return true; });
      });
  }

  // Take over the notifications panel from the web-push flow. In a native
  // webview PushManager doesn't exist, so the web flow leaves the panel hidden;
  // we show it and wire the button to FCM registration instead.
  function initNativePushPanel() {
    if (!Push) return;
    fetch("/api/push/config", { credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (cfg) {
        if (!cfg || !cfg.fcmEnabled) return;
        // Cache googleClientId while we have the response.
        if (cfg.googleClientId) googleClientId = cfg.googleClientId;
        var panel = document.getElementById("push-panel");
        var btn = document.getElementById("push-enable-btn");
        if (!panel || !btn) return;
        panel.hidden = false;
        var nativeBtn = btn.cloneNode(true);
        btn.replaceWith(nativeBtn);
        nativeBtn.disabled = false;

        Push.checkPermissions().then(function (perm) {
          if (perm.receive === "granted") {
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
