import { useState } from "react";
import "./LoginScreen.css";

// ★ソフトテニス記録アプリ ログイン画面（デザイン刷新版）
// ・見た目のみを担当する自己完結コンポーネント。実際のSupabaseログイン処理は
//   親（AuthScreen）から渡される onLogin プロップが行う（責務を分離するため）。
// ・onLogin は { email, password, keepLoggedIn } を受け取り、失敗時は例外を投げる想定。
//   例外の message はそのままエラー表示に使われる。
// ・onSwitchToSignup で新規登録画面への切り替えを親に委譲する。
// ・onForgotPassword を渡すと「パスワードをお忘れの方」がクリック可能になる（渡さなければ非表示）。
export default function LoginScreen({ onLogin, onSwitchToSignup, onForgotPassword, isLoading = false, initialEmail = "" }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [keepLoggedIn, setKeepLoggedIn] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const busy = isLoading || submitting;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    if (!email.trim()) return setError("メールアドレスを入力してください。");
    if (password.length < 6) return setError("パスワードは6文字以上で入力してください。");

    setSubmitting(true);
    try {
      await onLogin?.({ email: email.trim(), password, keepLoggedIn });
    } catch (err) {
      setError(err?.message || "ログインに失敗しました。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="st-login-page">
      <section className="st-login-hero" aria-labelledby="login-title">
        <div className="st-login-visual" aria-hidden="true">
          <span className="st-login-emoji">🎾</span>
        </div>

        <div className="st-login-heading">
          <h1 id="login-title">ソフトテニス<br />記録アプリ</h1>
          <p>スコア記録・データ分析で<br />チームの成長をサポート</p>
        </div>

        <div className="st-login-card">
          <div className="st-login-tabs" role="tablist" aria-label="認証方法">
            <button className="st-login-tab is-active" type="button" role="tab" aria-selected="true">👤 ログイン</button>
            <button className="st-login-tab" type="button" role="tab" aria-selected="false" onClick={onSwitchToSignup}>✎ 新規登録</button>
          </div>

          <form className="st-login-form" onSubmit={handleSubmit} noValidate>
            <label className="st-login-field">
              <span>メールアドレス</span>
              <div className="st-login-input-wrap">
                <span className="st-login-input-icon">✉</span>
                <input type="email" autoComplete="email" inputMode="email" autoCapitalize="none" placeholder="メールアドレスを入力" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </label>

            <label className="st-login-field">
              <span>パスワード（6文字以上）</span>
              <div className="st-login-input-wrap">
                <span className="st-login-input-icon">🔒</span>
                <input type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="パスワードを入力" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button className="st-login-eye" type="button" onClick={() => setShowPassword(v => !v)}>{showPassword ? "🙈" : "👁"}</button>
              </div>
            </label>

            <div className="st-login-options">
              <label className="st-login-check">
                <input type="checkbox" checked={keepLoggedIn} onChange={(e) => setKeepLoggedIn(e.target.checked)} />
                <span>ログイン状態を保持する</span>
              </label>
              {onForgotPassword && (
                <button className="st-login-link" type="button" onClick={onForgotPassword}>パスワードをお忘れの方</button>
              )}
            </div>

            {error && <p className="st-login-error" role="alert">{error}</p>}
            <button className="st-login-submit" type="submit" disabled={busy}>{busy ? "ログイン中…" : "ログイン"}</button>
          </form>
        </div>

        <section className="st-login-features" aria-label="主な機能">
          <article><div className="st-login-feature-icon">✓</div><strong>スコアを簡単記録</strong><span>試合のスコアを素早く入力</span></article>
          <article><div className="st-login-feature-icon">📊</div><strong>データを分析</strong><span>プレーやチームの傾向を可視化</span></article>
          <article><div className="st-login-feature-icon">☁</div><strong>いつでも同期</strong><span>複数端末でデータを安全に共有</span></article>
        </section>

        <footer className="st-login-footer">© 2026 Soft Tennis App</footer>
      </section>
    </main>
  );
}
