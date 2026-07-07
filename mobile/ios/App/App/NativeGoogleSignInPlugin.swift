import Foundation
import Capacitor
import GoogleSignIn

// Bridges the native Google Sign-In sheet to JS — same contract as the Android
// plugin: signIn({webClientId, scopes, offlineAccess}) resolves with
// {idToken, email, name, serverAuthCode?}. Returning users are verified via
// POST /api/auth/google/id-token; first-time users hand the one-time
// serverAuthCode to POST /api/auth/google/native-code — so sign-in AND sign-up
// both complete inside the app, no Safari sheet.
//
// Requires GIDClientID in Info.plist (the iOS OAuth client ID from the same
// Google Cloud project) plus its reversed-client-ID URL scheme. When those are
// missing this plugin rejects, and the JS bridge falls back to the browser
// flow — builds stay green before the console setup is done.
@objc(NativeGoogleSignInPlugin)
public class NativeGoogleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeGoogleSignInPlugin"
    public let jsName = "NativeGoogleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
    ]

    @objc func signIn(_ call: CAPPluginCall) {
        let webClientId = call.getString("webClientId") ?? ""
        guard !webClientId.isEmpty else {
            call.reject("webClientId is required")
            return
        }
        guard let iosClientId = Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String,
              !iosClientId.isEmpty, !iosClientId.hasPrefix("YOUR_") else {
            // iOS OAuth client not configured yet — JS falls back to the browser.
            call.reject("IOS_CLIENT_ID_MISSING")
            return
        }

        let offlineAccess = call.getBool("offlineAccess") ?? false
        let scopes = (call.getArray("scopes") as? [String] ?? []).filter { !$0.isEmpty }

        // serverClientID makes GIDSignIn mint the serverAuthCode against our
        // backend's (web) client, so the server can exchange it for tokens.
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(
            clientID: iosClientId,
            serverClientID: offlineAccess ? webClientId : nil
        )

        DispatchQueue.main.async { [weak self] in
            guard let viewController = self?.bridge?.viewController else {
                call.reject("NO_VIEW_CONTROLLER")
                return
            }
            GIDSignIn.sharedInstance.signIn(
                withPresenting: viewController,
                hint: nil,
                additionalScopes: scopes
            ) { result, error in
                if let error = error {
                    let code = (error as NSError).code
                    // -5 == user closed the sheet; anything else is a real failure.
                    call.reject(code == GIDSignInError.canceled.rawValue ? "SIGN_IN_CANCELLED" : "SIGN_IN_FAILED",
                                String(code), error)
                    return
                }
                guard let user = result?.user, let idToken = user.idToken?.tokenString else {
                    call.reject("NO_ID_TOKEN")
                    return
                }
                var ret: [String: Any] = [
                    "idToken": idToken,
                    "email": user.profile?.email ?? "",
                    "name": user.profile?.name ?? "",
                ]
                if let serverAuthCode = result?.serverAuthCode {
                    ret["serverAuthCode"] = serverAuthCode
                }
                call.resolve(ret)
            }
        }
    }

    @objc func signOut(_ call: CAPPluginCall) {
        GIDSignIn.sharedInstance.signOut()
        call.resolve()
    }
}
