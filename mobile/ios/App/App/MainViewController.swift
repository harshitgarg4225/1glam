import UIKit
import Capacitor

// Capacitor doesn't auto-discover plugins that live inside the app target —
// they must be registered on the bridge. Main.storyboard instantiates this
// subclass instead of CAPBridgeViewController directly.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeGoogleSignInPlugin())
    }
}
