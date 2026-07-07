package in.busydays.app;

import android.app.Activity;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Task;
import java.util.ArrayList;
import java.util.List;

// Bridges the native Google Sign-In account picker to JS.
// The JS bridge calls signIn({webClientId, scopes, offlineAccess}) and receives
// {idToken, email, name, serverAuthCode?}. The server verifies the ID token at
// POST /api/auth/google/id-token (returning users), or exchanges the one-time
// serverAuthCode at POST /api/auth/google/native-code (first-time users) — so
// both sign-in AND sign-up complete inside the app, no browser tab.
@CapacitorPlugin(name = "NativeGoogleSignIn")
public class NativeGoogleSignInPlugin extends Plugin {

    @PluginMethod
    public void signIn(PluginCall call) {
        String webClientId = call.getString("webClientId", "");
        if (webClientId == null || webClientId.isEmpty()) {
            call.reject("webClientId is required");
            return;
        }

        GoogleSignInOptions.Builder builder = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken(webClientId)
                .requestEmail();

        // Offline access returns a one-time server auth code the backend can
        // exchange for refresh tokens — this is what lets a brand-new user be
        // provisioned (Sheets/Calendar/Drive) without ever leaving the app.
        boolean offlineAccess = Boolean.TRUE.equals(call.getBoolean("offlineAccess", false));
        List<Scope> scopes = parseScopes(call.getArray("scopes"));
        if (offlineAccess) {
            builder.requestServerAuthCode(webClientId, false);
        }
        if (!scopes.isEmpty()) {
            Scope first = scopes.get(0);
            Scope[] rest = scopes.subList(1, scopes.size()).toArray(new Scope[0]);
            builder.requestScopes(first, rest);
        }

        GoogleSignInClient client = GoogleSignIn.getClient(getContext(), builder.build());

        // Silent sign-in first — succeeds when the user recently signed in with
        // the same scopes. (A silent result carries no fresh serverAuthCode; the
        // JS bridge only needs the code for FIRST-TIME users, who always take
        // the interactive path below because silent sign-in fails for them.)
        client.silentSignIn().addOnCompleteListener(getActivity(), task -> {
            if (task.isSuccessful()) {
                resolveAccount(call, task.getResult());
            } else {
                // Show the native account-picker bottom sheet.
                startActivityForResult(call, client.getSignInIntent(), "signInCallback");
            }
        });
    }

    private List<Scope> parseScopes(JSArray raw) {
        List<Scope> scopes = new ArrayList<>();
        if (raw == null) return scopes;
        try {
            for (Object value : raw.toList()) {
                String scope = String.valueOf(value);
                if (!scope.isEmpty() && !"null".equals(scope)) scopes.add(new Scope(scope));
            }
        } catch (Exception ignored) {
            // Malformed scopes → identity-only sign-in; the bridge falls back
            // to the browser flow for first-time users.
        }
        return scopes;
    }

    @ActivityCallback
    private void signInCallback(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("SIGN_IN_CANCELLED");
            return;
        }
        Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(result.getData());
        try {
            resolveAccount(call, task.getResult(ApiException.class));
        } catch (ApiException e) {
            call.reject("SIGN_IN_FAILED", String.valueOf(e.getStatusCode()));
        }
    }

    private void resolveAccount(PluginCall call, GoogleSignInAccount account) {
        if (account == null) {
            call.reject("No account returned");
            return;
        }
        String idToken = account.getIdToken();
        if (idToken == null) {
            // Happens when webClientId is wrong or not registered in Google Cloud Console.
            call.reject("NO_ID_TOKEN");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("idToken", idToken);
        ret.put("email", account.getEmail() != null ? account.getEmail() : "");
        ret.put("name", account.getDisplayName() != null ? account.getDisplayName() : "");
        if (account.getServerAuthCode() != null) {
            ret.put("serverAuthCode", account.getServerAuthCode());
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        GoogleSignInOptions gso = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN).build();
        GoogleSignIn.getClient(getContext(), gso).signOut()
                .addOnCompleteListener(task -> call.resolve());
    }
}
