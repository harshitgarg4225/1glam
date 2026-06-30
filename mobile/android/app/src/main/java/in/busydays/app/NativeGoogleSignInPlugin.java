package in.busydays.app;

import android.app.Activity;
import androidx.activity.result.ActivityResult;
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
import com.google.android.gms.tasks.Task;

// Bridges the native Google Sign-In account picker to JS.
// The JS bridge calls signIn({webClientId}) and receives {idToken, email, name}.
// The server verifies the ID token at POST /api/auth/google/id-token.
@CapacitorPlugin(name = "NativeGoogleSignIn")
public class NativeGoogleSignInPlugin extends Plugin {

    @PluginMethod
    public void signIn(PluginCall call) {
        String webClientId = call.getString("webClientId", "");
        if (webClientId == null || webClientId.isEmpty()) {
            call.reject("webClientId is required");
            return;
        }

        GoogleSignInOptions gso = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken(webClientId)
                .requestEmail()
                .build();

        GoogleSignInClient client = GoogleSignIn.getClient(getContext(), gso);

        // Silent sign-in first — succeeds when the user recently signed in.
        client.silentSignIn().addOnCompleteListener(getActivity(), task -> {
            if (task.isSuccessful()) {
                resolveAccount(call, task.getResult());
            } else {
                // Show the native account-picker bottom sheet.
                startActivityForResult(call, client.getSignInIntent(), "signInCallback");
            }
        });
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
        call.resolve(ret);
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        GoogleSignInOptions gso = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN).build();
        GoogleSignIn.getClient(getContext(), gso).signOut()
                .addOnCompleteListener(task -> call.resolve());
    }
}
