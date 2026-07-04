export default async function handler(req, res) {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
      return res.status(500).json({
        ok: false,
        error: "環境変数 SUPABASE_URL / SUPABASE_ANON_KEY が設定されていません。Vercelの設定画面で追加してください。",
      });
    }

    const r = await fetch(`${url}/rest/v1/schools?select=id&limit=1`, {
      headers: {
        apikey: key,
      },
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ ok: false, status: r.status, body: text });
    }

    return res.status(200).json({ ok: true, message: "Supabaseへのpingに成功しました", time: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
