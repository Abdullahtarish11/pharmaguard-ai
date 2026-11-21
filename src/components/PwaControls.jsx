import { useEffect, useState } from 'react';

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.navigator?.standalone === true;
    setIsInstalled(Boolean(isStandalone));

    const ua = window.navigator?.userAgent?.toLowerCase() ?? '';
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredPrompt(event);
    };

    const onAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  async function install() {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  }

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    install,
  };
}

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button className="btn btn-soft btn-sm" type="button" onClick={install}>
        تثبيت التطبيق
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowIOSGuide(true)}>
          تثبيت على iOS
        </button>
        {showIOSGuide && (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="تثبيت التطبيق على iPhone">
            <div className="modal-card">
              <h3 className="section-title">تثبيت PharmaGuard على iPhone / iPad</h3>
              <ol className="steps">
                <li>اضغط على زر المشاركة (Share) في شريط Safari.</li>
                <li>اختر «إضافة إلى الشاشة الرئيسية» (Add to Home Screen).</li>
                <li>اضغط «إضافة» ليظهر التطبيق كأيقونة مستقلة.</li>
              </ol>
              <div className="btn-row">
                <button className="btn btn-primary" type="button" onClick={() => setShowIOSGuide(false)}>
                  فهمت
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}

export function OfflineIndicator() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div className="offline-toast" role="status" aria-live="polite">
      <span className="dot-warn" />
      وضع عدم الاتصال — يتم استخدام الهيكل المخزّن، وتحتاج العمليات الحية اتصالًا بالشبكة.
    </div>
  );
}
