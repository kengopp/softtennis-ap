import { useState, useCallback, useEffect, useRef } from "react";
import { supabase } from "./supabase-client";

// ============================================================
// 定数
// ============================================================
const GAME_FORMATS = [5, 7, 9];
const MATCH_TYPES = [
  { key: "tournament", label: "公式大会" },
  { key: "practice",   label: "練習試合" },
  { key: "internal",   label: "部内戦"   },
];

// プレイ内容（ショット種別）
const PLAY_TYPES = [
  { key: "serve",    label: "サーブ"    },
  { key: "receive",  label: "レシーブ"  },
  { key: "volley",   label: "ボレー"    },
  { key: "smash",    label: "スマッシュ" },
  { key: "stroke",   label: "ストローク" },
  { key: "attack",   label: "アタック"  },
  { key: "shoot",    label: "シュート"  },
  { key: "lob",      label: "ロブ"      },
  { key: "drop",     label: "ドロップ"  },
];

// 結果（新規記録時の選択肢：ウィナー / エラーの2択）
const RESULT_TYPES = [
  { key: "winner", label: "ウィナー", is_winner: true  },
  { key: "error",  label: "エラー",   is_winner: false },
];
// ラベル・勝敗判定（過去データに残る "ace" も正しく表示できるよう選択肢とは別管理）
const RESULT_LABELS    = { winner: "ウィナー", ace: "エース", error: "エラー" };
const RESULT_IS_WINNER = { winner: true,        ace: true,    error: false   };

// フォア / バック
const SIDE_TYPES = [
  { key: "forehand", label: "フォア" },
  { key: "backhand",  label: "バック" },
];

// shot_typeキー（DB保存用：プレイ内容_結果 の組み合わせで生成）
const buildShotKey = (play, result) => play && result ? `${play}_${result}` : play ?? result ?? null;

const getPlayLabel   = (key) => PLAY_TYPES.find(p => p.key === key)?.label ?? key ?? "—";
const getResultLabel = (key) => RESULT_LABELS[key] ?? key ?? "";
const getSideLabel   = (key) => SIDE_TYPES.find(s => s.key === key)?.label ?? key ?? "";
const isWinnerResult = (result) => RESULT_IS_WINNER[result] ?? null;

const C = {
  navy:    "#0f2044",
  navyMid: "#1a3360",
  accent:  "#00c27a",
  accentL: "#e6faf3",
  orange:  "#f97316",
  red:     "#e53935",
  redL:    "#fdecea",
  purple:  "#6366f1",
  gray:    "#f4f6f9",
  border:  "#dde2ea",
  text:    "#1a2236",
  textSec: "#7a8499",
  white:   "#ffffff",
  teamA:   "#0ea5e9",
  teamB:   "#f97316",
  serve:   "#fbbf24",
};

// ============================================================
// データ層（Supabase接続）
// ============================================================
const uid = () => (crypto.randomUUID ? crypto.randomUUID() :
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  }));
const today  = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => iso ? iso.replace(/-/g, "/") : "";

// DBのshot_type制約に合う組み合わせのみ許可。合わなければnull（保存はできる）
const VALID_SHOT_TYPES = new Set([
  "serve_ace","volley_winner","smash_winner","stroke_winner","return_winner",
  "drop_winner","lob_winner","approach_winner","stroke_error","volley_error",
  "smash_error","return_error","drop_error","lob_error","net_cord","double_fault",
]);
const toShotType = (play, result) => {
  const key = buildShotKey(play, result);
  return VALID_SHOT_TYPES.has(key) ? key : null;
};

// 試合一覧を取得（自分が作成したもののみ。RLSで自動的に絞られる）
async function getMatches() {
  const { data, error } = await supabase
    .from("matches")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) { console.error(error); return []; }
  return data.map(rowToMatchSummary);
}

// 試合1件を、関連テーブルすべて含めて取得
async function getMatch(id) {
  if (!id) return null;
  const { data: m, error } = await supabase.from("matches").select("*").eq("id", id).single();
  if (error || !m) { console.error(error); return null; }

  const [{ data: players }, { data: games }, { data: points }, { data: faults }] = await Promise.all([
    supabase.from("match_players").select("*").eq("match_id", id).order("team").order("order_num"),
    supabase.from("games").select("*").eq("match_id", id).order("game_number"),
    supabase.from("points").select("*").eq("match_id", id).order("point_number"),
    supabase.from("faults").select("*").eq("match_id", id).order("fault_number"),
  ]);

  return rowToMatchFull(m, players ?? [], games ?? [], points ?? [], faults ?? []);
}

function rowToMatchSummary(m) {
  return {
    id: m.id, created_by: m.created_by,
    match_date: m.match_date, venue: m.venue ?? "",
    tournament_name: m.tournament_name ?? "", round: m.round ?? "",
    match_type: m.match_type, game_format: m.game_format,
    is_doubles: m.is_doubles, first_server: m.first_server, status: m.status,
    match_score_a: m.match_score_a, match_score_b: m.match_score_b,
    memo: m.memo ?? "", players: [], games: [],
  };
}

function rowToMatchFull(m, players, games, points, faults) {
  return {
    id: m.id, created_by: m.created_by,
    match_date: m.match_date, venue: m.venue ?? "",
    tournament_name: m.tournament_name ?? "", round: m.round ?? "",
    match_type: m.match_type, game_format: m.game_format,
    is_doubles: m.is_doubles, first_server: m.first_server, status: m.status,
    match_score_a: m.match_score_a, match_score_b: m.match_score_b,
    memo: m.memo ?? "",
    players: players.map(p => ({
      id: p.id, team: p.team, player_name: p.player_name,
      club_name: p.club_name ?? "", position: p.position ?? "", order_num: p.order_num,
    })),
    games: games.map(g => ({
      id: g.id, match_id: m.id, game_number: g.game_number, server_team: g.server_team,
      is_final: g.is_final, score_a: g.score_a, score_b: g.score_b, winner_team: g.winner_team,
      faults: faults.filter(f => f.game_id === g.id).map(f => ({
        id: f.id, game_id: f.game_id, match_id: m.id, fault_number: f.fault_number,
        server_team: f.server_team, player_name: f.player_name,
        score_a_at: f.score_a_at, score_b_at: f.score_b_at,
      })),
      points: points.filter(pt => pt.game_id === g.id).map(pt => ({
        id: pt.id, game_id: pt.game_id, match_id: m.id, point_number: pt.point_number,
        scoring_team: pt.scoring_team, player_name: pt.player_name,
        play_type: pt.play_type ?? null, side_type: pt.side_type ?? null, result_type: pt.result_type ?? null,
        is_winner: pt.is_winner, score_a_after: pt.score_a_after, score_b_after: pt.score_b_after,
      })),
    })),
  };
}

// 試合1件を関連テーブルごと保存（新規・更新どちらも対応）
async function saveMatch(match) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");

  const matchRow = {
    id: match.id, created_by: (match.created_by && match.created_by !== "me") ? match.created_by : user.id,
    match_date: match.match_date, venue: match.venue || null,
    tournament_name: match.tournament_name || null, round: match.round || null,
    match_type: match.match_type, game_format: match.game_format,
    is_doubles: match.is_doubles, first_server: match.first_server, status: match.status,
    match_score_a: match.match_score_a, match_score_b: match.match_score_b,
    memo: match.memo || null,
  };
  const { error: mErr } = await supabase.from("matches").upsert(matchRow);
  if (mErr) throw mErr;

  // 選手情報：一旦削除してから入れ直す（シンプルで確実な方式）
  await supabase.from("match_players").delete().eq("match_id", match.id);
  if (match.players?.length) {
    const playerRows = match.players.map(p => ({
      id: p.id, match_id: match.id, team: p.team, player_name: p.player_name,
      club_name: p.club_name || null, position: p.position || null, order_num: p.order_num,
    }));
    const { error: pErr } = await supabase.from("match_players").insert(playerRows);
    if (pErr) throw pErr;
  }

  // ゲーム・ポイント・フォルトも同様に、入れ直す
  await supabase.from("games").delete().eq("match_id", match.id);
  for (const g of (match.games ?? [])) {
    const gameRow = {
      id: g.id, match_id: match.id, game_number: g.game_number, server_team: g.server_team,
      is_final: g.is_final, score_a: g.score_a, score_b: g.score_b, winner_team: g.winner_team || null,
    };
    const { error: gErr } = await supabase.from("games").insert(gameRow);
    if (gErr) throw gErr;

    if (g.points?.length) {
      const pointRows = g.points.map(pt => ({
        id: pt.id, game_id: g.id, match_id: match.id, point_number: pt.point_number,
        scoring_team: pt.scoring_team, player_name: pt.player_name || null,
        shot_type: toShotType(pt.play_type, pt.result_type),
        play_type: pt.play_type || null, side_type: pt.side_type || null, result_type: pt.result_type || null,
        is_winner: pt.is_winner, score_a_after: pt.score_a_after, score_b_after: pt.score_b_after,
      }));
      const { error: ptErr } = await supabase.from("points").insert(pointRows);
      if (ptErr) throw ptErr;
    }
    if (g.faults?.length) {
      const faultRows = g.faults.map(f => ({
        id: f.id, game_id: g.id, match_id: match.id, fault_number: f.fault_number,
        server_team: f.server_team, player_name: f.player_name || null,
        score_a_at: f.score_a_at, score_b_at: f.score_b_at,
      }));
      const { error: fErr } = await supabase.from("faults").insert(faultRows);
      if (fErr) throw fErr;
    }
  }
}

async function deleteMatch(id) {
  const { error } = await supabase.from("matches").delete().eq("id", id);
  if (error) throw error;
}

// ============================================================
// プロフィール
// ============================================================
async function getMyProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from("users").select("*").eq("id", user.id).single();
  if (error) { console.error(error); return null; }
  return data;
}

async function saveMyProfile(profile) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  const { error } = await supabase.from("users").update({
    name: profile.name,
    school_name: profile.school_name,
    prefecture: profile.prefecture,
    category: profile.category,
  }).eq("id", user.id);
  if (error) throw error;
}

// ============================================================
// 選手マスター（同じ学校のメンバーで共有）
// ============================================================
async function getPlayerRoster() {
  const { data, error } = await supabase.from("players").select("*").order("player_name");
  if (error) { console.error(error); return []; }
  return data;
}

async function savePlayer(player) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  const profile = await getMyProfile();
  const row = {
    id: player.id || uid(),
    school_name: profile?.school_name || "",
    player_name: player.player_name,
    position: player.position || null,
    created_by: user.id,
  };
  const { error } = await supabase.from("players").upsert(row);
  if (error) throw error;
  return row;
}

async function deletePlayerFromRoster(id) {
  const { error } = await supabase.from("players").delete().eq("id", id);
  if (error) throw error;
}

// ============================================================
// 学校名サジェスト（誤入力防止のための候補一覧）
// 登録済みユーザーの学校名 ＋ これまで試合で入力されたチーム名 を候補にする
// ============================================================
async function getKnownSchoolNames() {
  const [{ data: rpcData, error: rpcErr }, { data: cpData, error: cpErr }] = await Promise.all([
    supabase.rpc("list_school_names"),
    supabase.from("match_players").select("club_name"),
  ]);
  if (rpcErr) console.error(rpcErr);
  if (cpErr) console.error(cpErr);
  const set = new Set();
  (rpcData ?? []).forEach(v => { const s = typeof v === "string" ? v : Object.values(v||{})[0]; if (s) set.add(s); });
  (cpData ?? []).forEach(r => { if (r.club_name) set.add(r.club_name); });
  return Array.from(set).sort((a,b)=>a.localeCompare(b,"ja"));
}

// ============================================================
// ゲームロジック
// ============================================================
const calcWinGames = (fmt) => Math.ceil(fmt / 2);
const isFinalGame  = (fmt, sA, sB) => { const w = calcWinGames(fmt); return sA === w-1 && sB === w-1; };
const gameServer   = (first, num)  => num % 2 === 1 ? first : (first === "A" ? "B" : "A");

function checkNormalWinner(a, b) {
  if (a >= 4 && a - b >= 2) return "A";
  if (b >= 4 && b - a >= 2) return "B";
  return null;
}
function checkFinalWinner(a, b) {
  if (a >= 7 && a - b >= 2) return "A";
  if (b >= 7 && b - a >= 2) return "B";
  return null;
}
function finalServer(first, played) {
  return Math.floor(played / 2) % 2 === 0 ? first : (first === "A" ? "B" : "A");
}

// ============================================================
// 統計計算（play_type / result_type ベースに対応）
// ============================================================
function calcPlayerStats(match) {
  // 選手名 -> 所属チーム('A'/'B') の対応表（match_playersが正、scoring_teamには依存しない）
  const teamOf = {};
  for (const p of match.players) teamOf[p.player_name] = p.team;

  const result = {};
  for (const g of match.games) {
    for (const pt of g.points) {
      if (!pt.player_name) continue;
      const playerTeam = teamOf[pt.player_name] ?? pt.scoring_team;
      const key = playerTeam + "__" + pt.player_name;
      if (!result[key]) result[key] = { team: playerTeam, player_name: pt.player_name, total: 0, winners: 0, errors: 0, plays: {}, results: {} };
      const r = result[key];
      r.total++;
      if (pt.is_winner) r.winners++; else r.errors++;
      if (pt.play_type)   r.plays[pt.play_type]     = (r.plays[pt.play_type]   ?? 0) + 1;
      if (pt.result_type) r.results[pt.result_type] = (r.results[pt.result_type] ?? 0) + 1;
    }
    for (const f of (g.faults ?? [])) {
      if (!f.player_name) continue;
      const playerTeam = teamOf[f.player_name] ?? f.server_team;
      const key = playerTeam + "__" + f.player_name;
      if (!result[key]) result[key] = { team: playerTeam, player_name: f.player_name, total: 0, winners: 0, errors: 0, plays: {}, results: {} };
      result[key].plays["fault"] = (result[key].plays["fault"] ?? 0) + 1;
    }
  }
  return Object.values(result);
}

function calcAutoComment(stats, team) {
  const comments = [];
  for (const p of stats.filter(s => s.team === team)) {
    const topPlay   = Object.entries(p.plays).sort((a,b)=>b[1]-a[1])[0];
    const topResult = Object.entries(p.results).sort((a,b)=>b[1]-a[1])[0];
    if (topPlay && p.winners > 0) {
      const pct = Math.round((p.plays[topPlay[0]] ?? 0) / p.total * 100);
      comments.push({ type: "strength", player: p.player_name, text: `${getPlayLabel(topPlay[0])}が全ポイントの${pct}%を占める主な得点パターン。` });
    }
    if (p.errors > 0 && topResult && !isWinnerResult(topResult[0])) {
      const pct = Math.round(topResult[1] / (p.errors || 1) * 100);
      comments.push({ type: "weakness", player: p.player_name, text: `${getResultLabel(topResult[0])}による失点が${pct}%。重点的に改善が必要。` });
    }
    const df = p.plays["fault"] ?? 0;
    if (df >= 2) comments.push({ type: "warning", player: p.player_name, text: `1stフォルト${df}回。サーブの安定が課題。` });
  }
  return comments;
}

// LINE共有テキスト
// LINE共有テキスト
function buildLineText(match) {
  var aP = match.players.filter(function(p){return p.team==="A";}).map(function(p){return p.player_name;}).join("/");
  var bP = match.players.filter(function(p){return p.team==="B";}).map(function(p){return p.player_name;}).join("/");
  var aC = (match.players.find(function(p){return p.team==="A";}) || {}).club_name || "";
  var bC = (match.players.find(function(p){return p.team==="B";}) || {}).club_name || "";
  var aWin = match.match_score_a > match.match_score_b;
  var t = "\u{1F3BE} \u8A66\u5408\u7D50\u679C\n";
  if (match.tournament_name) t += match.tournament_name + (match.round ? " " + match.round : "") + "\n";
  t += fmtDate(match.match_date) + (match.venue ? " @" + match.venue : "") + "\n\n";
  t += (aWin ? "\u{1F3C6} " : "") + aC + " " + aP + "\n";
  t += (!aWin && match.status==="finished" ? "\u{1F3C6} " : "") + bC + " " + bP + "\n\n";
  t += "\u30B9\u30B3\u30A2 " + match.match_score_a + " - " + match.match_score_b + "\n";
  match.games.forEach(function(g) { t += "G" + g.game_number + (g.is_final ? "(F)" : "") + ": " + g.score_a + "-" + g.score_b + "\n"; });
  return t;
}

// CSV出力
function buildCsv(match) {
  const headers = ["試合日","大会名","何回戦","ゲーム番号","ファイナルゲーム","ポイント番号","得点チーム","チーム区分","選手名","所属","プレイ内容","フォア/バック","結果","チームA得点","チームB得点"];
  const rows = [];
  for (const g of match.games) {
    for (const f of (g.faults ?? [])) {
      const pl = match.players.find(p=>p.player_name===f.player_name);
      rows.push([match.match_date,match.tournament_name??"",match.round??"",g.game_number,g.is_final?"YES":"NO","","",f.server_team==="A"?"自チーム":"相手チーム",f.player_name??"",pl?.club_name??""," 1stフォルト","","fault",f.score_a_at,f.score_b_at]);
    }
    for (const pt of g.points) {
      const pl = match.players.find(p=>p.player_name===pt.player_name);
      rows.push([match.match_date,match.tournament_name??"",match.round??"",g.game_number,g.is_final?"YES":"NO",pt.point_number,pt.scoring_team,pt.scoring_team==="A"?"自チーム":"相手チーム",pt.player_name??"",pl?.club_name??"",pt.play_type?getPlayLabel(pt.play_type):"",pt.side_type?getSideLabel(pt.side_type):"",pt.result_type?getResultLabel(pt.result_type):"",pt.score_a_after,pt.score_b_after]);
    }
  }
  const esc = v => { const s = String(v == null ? "" : v); if (s.indexOf(",") >= 0 || s.indexOf('"') >= 0 || s.indexOf("\n") >= 0) { return '"' + s.split('"').join('""'  ) + '"'; } return s; };
  return "\uFEFF"+[headers,...rows].map(r=>r.map(esc).join(",")).join("\n");
}

function downloadCsv(match) {
  const blob = new Blob([buildCsv(match)],{type:"text/csv;charset=utf-8;"});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href=url; a.download=`softtennis_${match.match_date}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ============================================================
// スタイル共通
// ============================================================
const S = {
  page:   { background: C.gray, minHeight:"100vh", paddingBottom:80, fontFamily:"'Helvetica Neue','Hiragino Kaku Gothic ProN','Meiryo',sans-serif" },
  hdr:    { background:`linear-gradient(135deg,${C.navy},${C.navyMid})`, padding:"12px 16px", position:"sticky", top:0, zIndex:10 },
  card:   { background:C.white, borderRadius:12, border:`1px solid ${C.border}`, overflow:"hidden", marginBottom:10 },
  inp:    { width:"100%", padding:"8px 0", background:"transparent", border:"none", borderBottom:`1px solid ${C.border}`, fontSize:14, color:C.text, outline:"none", boxSizing:"border-box" },
  lbl:    { display:"block", fontSize:11, color:C.textSec, marginBottom:4 },
  btn:    (bg,color="white")=>({ padding:"13px 16px", background:bg, color, border:"none", borderRadius:10, fontSize:14, fontWeight:700, cursor:"pointer", width:"100%" }),
  togBtn: (active,ac=C.navy)=>({ padding:"8px 14px", borderRadius:8, border:`1px solid ${C.border}`, background:active?ac:C.white, color:active?C.white:C.text, fontWeight:active?700:400, fontSize:13, cursor:"pointer" }),
  chip:   (sel)=>({ display:"inline-block", padding:"5px 12px", borderRadius:20, border:`1px solid ${sel?C.navy:C.border}`, background:sel?C.navy:C.white, color:sel?C.white:C.text, fontSize:12, fontWeight:sel?700:400, cursor:"pointer", margin:"2px" }),
  row:    { padding:"10px 14px", borderBottom:`1px solid ${C.border}` },
};

// ============================================================
// 共通コンポーネント
// ============================================================
function Modal({ children, onClose }) {
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999,padding:20 }} onClick={onClose}>
      <div style={{ background:C.white,borderRadius:20,padding:"28px 20px",width:"100%",maxWidth:340 }} onClick={e=>e.stopPropagation()}>{children}</div>
    </div>
  );
}

function NavBar({ active }) {
  return (
    <div style={{ position:"fixed",bottom:0,left:0,right:0,background:C.white,borderTop:`1px solid ${C.border}`,display:"flex",zIndex:10 }}>
      {[["🏠","ホーム"],["🎾","記録"],["📊","統計"],["📋","履歴"]].map(([icon,label],i)=>(
        <div key={i} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",padding:"6px 0 4px",fontSize:9,fontWeight:600,color:active===i?C.accent:C.textSec }}>
          <span style={{ fontSize:20 }}>{icon}</span>{label}
        </div>
      ))}
    </div>
  );
}

// ★試合終了後のスコア修正：ポイントをタップした際に開く編集モーダル
function PointEditModal({ mode="edit", point, players, teamALabel, teamBLabel, onClose, onSave, onDelete }) {
  const [team,   setTeam]   = useState(point.scoring_team || "A");
  const [play,   setPlay]   = useState(point.play_type);
  const [side,   setSide]   = useState(point.side_type);
  const [result, setResult] = useState(point.result_type);
  const [playerName, setPlayerName] = useState(point.player_name);

  function handleSave(){
    const isWin = result ? isWinnerResult(result) : null;
    onSave({ scoring_team:team, play_type:play, side_type:side, result_type:result, player_name:playerName, is_winner:isWin });
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ maxHeight:"72vh", overflowY:"auto" }}>
        <h3 style={{ fontSize:16,fontWeight:800,marginBottom:14,textAlign:"center" }}>{mode==="add"?"ポイントを追加":"ポイントを修正"}</h3>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>得点チーム</div>
          <div style={{ display:"flex",gap:8 }}>
            <button style={{ ...S.togBtn(team==="A"),flex:1 }} onClick={()=>setTeam("A")}>{teamALabel||"自チーム"}</button>
            <button style={{ ...S.togBtn(team==="B"),flex:1 }} onClick={()=>setTeam("B")}>{teamBLabel||"相手"}</button>
          </div>
        </div>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>プレイ内容</div>
          <div>
            {PLAY_TYPES.map(p=>(
              <span key={p.key} style={S.chip(play===p.key)} onClick={()=>setPlay(play===p.key?null:p.key)}>{p.label}</span>
            ))}
          </div>
        </div>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>フォア / バック</div>
          <div>
            {SIDE_TYPES.map(s=>(
              <span key={s.key} style={S.chip(side===s.key)} onClick={()=>setSide(side===s.key?null:s.key)}>{s.label}</span>
            ))}
          </div>
        </div>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>結果</div>
          <div>
            {RESULT_TYPES.map(r=>(
              <span key={r.key} style={S.chip(result===r.key)} onClick={()=>setResult(result===r.key?null:r.key)}>{r.label}</span>
            ))}
          </div>
        </div>

        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>選手</div>
          <div>
            {players.map(p=>(
              <span key={p.id} style={S.chip(playerName===p.name)} onClick={()=>setPlayerName(playerName===p.name?null:p.name)}>{p.name}</span>
            ))}
          </div>
        </div>

        <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), marginBottom:8 }} onClick={handleSave}>{mode==="add"?"追加する":"保存する"}</button>
        {mode==="edit" && (
          <button style={{ ...S.btn("#fff"),color:C.red,border:"1px solid "+C.red, marginBottom:8 }} onClick={onDelete}>🗑 このポイントを削除</button>
        )}
        <button style={{ ...S.btn("#f0f0f0"),color:C.text }} onClick={onClose}>キャンセル</button>
      </div>
    </Modal>
  );
}

// ============================================================
// 試合一覧
// ============================================================
function MatchList({ onNew, onOpen, onCopy, onProfile, onRoster }) {
  const [filter, setFilter] = useState("all");
  const [allMatches, setAllMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null); // 削除確認対象のmatch_id

  const reload = useCallback(() => {
    setLoading(true);
    getMatches().then(list => { setAllMatches(list); setLoading(false); });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const matches = allMatches.filter(m=>filter==="all"||m.match_type===filter);

  async function handleDelete(id) {
    await deleteMatch(id);
    setConfirmDelete(null);
    reload();
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <span style={{ fontSize:20,fontWeight:800,color:C.white }}>試合一覧</span>
          <div style={{ display:"flex",gap:6 }}>
            <button
              style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:14, padding:"6px 9px", cursor:"pointer" }}
              onClick={onProfile} title="プロフィール"
            >👤</button>
            <button
              style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:14, padding:"6px 9px", cursor:"pointer" }}
              onClick={onRoster} title="選手マスター"
            >👥</button>
            <button
              style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:11, padding:"6px 10px", cursor:"pointer" }}
              onClick={async ()=>{ if(window.confirm("ログアウトしますか？")) { await supabase.auth.signOut(); } }}
            >ログアウト</button>
          </div>
        </div>
      </div>
      <div style={{ display:"flex",gap:6,padding:"12px 14px 0",overflowX:"auto" }}>
        {[["all","すべて"],["tournament","公式大会"],["practice","練習試合"],["internal","部内戦"]].map(([v,l])=>(
          <button key={v} style={{ ...S.togBtn(filter===v,C.navy),whiteSpace:"nowrap",fontSize:12 }} onClick={()=>setFilter(v)}>{l}</button>
        ))}
      </div>
      <div style={{ padding:"12px 14px" }}>
        {loading && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>}
        {!loading && matches.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}><div style={{ fontSize:40,marginBottom:12 }}>🎾</div>試合記録がありません</div>}
        {!loading && matches.map(m=>{
          const aWin=m.match_score_a>m.match_score_b;
          const aP=m.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/");
          const bP=m.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
          const aC=m.players.find(p=>p.team==="A")?.club_name??"";
          const bC=m.players.find(p=>p.team==="B")?.club_name??"";
          return (
            <div key={m.id} style={{ ...S.card,boxShadow:"0 1px 4px rgba(0,0,0,0.08)" }}>
              <div style={{ height:4,background:m.status==="finished"?(aWin?C.teamA:C.teamB):C.accent }}/>
              <div style={{ padding:"12px 14px",cursor:"pointer" }} onClick={()=>onOpen(m.id)}>
                <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
                  <span style={{ fontSize:13,fontWeight:700 }}>{m.tournament_name||"試合"}{m.round?` · ${m.round}`:""}</span>
                  <span style={{ fontSize:11,color:C.textSec }}>{fmtDate(m.match_date)}</span>
                </div>
                {m.venue&&<div style={{ fontSize:11,color:C.textSec,marginBottom:6 }}>📍 {m.venue}</div>}
                {[["A",aC,aP,m.match_score_a,aWin,C.teamA],["B",bC,bP,m.match_score_b,!aWin&&m.status==="finished",C.teamB]].map(([t,club,names,sc,win,col])=>(
                  <div key={t} style={{ display:"flex",alignItems:"center",padding:"2px 0" }}>
                    <span style={{ width:18,fontSize:13 }}>{win?"🏆":""}</span>
                    <span style={{ flex:1,fontSize:13,fontWeight:win?700:400 }}>{club} {names}</span>
                    <span style={{ fontSize:22,fontWeight:800,color:win?col:C.textSec }}>{sc??"-"}</span>
                  </div>
                ))}
                <div style={{ marginTop:8,display:"flex",justifyContent:"flex-end",gap:6 }}>
                  {[`${m.game_format}Gマッチ`,MATCH_TYPES.find(t=>t.key===m.match_type)?.label].filter(Boolean).map(l=>(
                    <span key={l} style={{ fontSize:10,padding:"2px 8px",borderRadius:20,background:C.navyMid+"22",color:C.navyMid,fontWeight:600 }}>{l}</span>
                  ))}
                  {m.status!=="finished"&&<span style={{ fontSize:10,padding:"2px 8px",borderRadius:20,background:"#fff3cd",color:"#7a5800",fontWeight:600 }}>進行中</span>}
                </div>
              </div>
              {/* コピー・削除ボタン行 */}
              <div style={{ display:"flex",borderTop:"1px solid "+C.border }}>
                <button
                  style={{ flex:1,padding:"9px",background:"#f0f6ff",color:"#1565c0",border:"none",fontSize:12,fontWeight:700,cursor:"pointer" }}
                  onClick={(e)=>{ e.stopPropagation(); onCopy(m.id); }}
                >📋 この試合情報をコピーして新規作成</button>
                <button
                  style={{ width:64,padding:"9px",background:"#fdecea",color:C.red,border:"none",borderLeft:"1px solid "+C.border,fontSize:12,fontWeight:700,cursor:"pointer" }}
                  onClick={(e)=>{ e.stopPropagation(); setConfirmDelete(m.id); }}
                >🗑 削除</button>
              </div>
            </div>
          );
        })}
      </div>
      <button style={{ position:"fixed",bottom:72,right:20,width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.accent},#00a066)`,color:C.white,fontSize:28,border:"none",cursor:"pointer",boxShadow:"0 4px 16px rgba(0,194,122,0.4)",display:"flex",alignItems:"center",justifyContent:"center" }} onClick={onNew}>＋</button>
      <NavBar active={3}/>

      {confirmDelete && (
        <Modal onClose={()=>setConfirmDelete(null)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40,marginBottom:8 }}>⚠️</div>
            <h3 style={{ fontSize:16,fontWeight:800,marginBottom:8 }}>この試合を削除しますか？</h3>
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>削除すると元に戻せません。スコア・スタッツデータもすべて削除されます。</p>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <button style={{ padding:"11px",background:"#f0f0f0",color:C.text,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>setConfirmDelete(null)}>キャンセル</button>
              <button style={{ padding:"11px",background:C.red,color:C.white,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>handleDelete(confirmDelete)}>削除する</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// セットアップ用 固定コンポーネント（関数外定義でフォーカスを保持）
// ============================================================
function FormSec({ title, children }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:11,fontWeight:700,color:C.navy,marginBottom:6,letterSpacing:"0.05em" }}>{title}</div>
      <div style={{ background:C.white,borderRadius:12,border:`1px solid ${C.border}`,overflow:"hidden" }}>{children}</div>
    </div>
  );
}
function FormRow({ label, children }) {
  return (
    <div style={{ padding:"10px 14px",borderBottom:`1px solid ${C.border}` }}>
      <label style={{ display:"block",fontSize:11,color:C.textSec,marginBottom:4 }}>{label}</label>
      {children}
    </div>
  );
}

// ★学校名の誤入力防止用：候補から選ぶ（プルダウン）か、新しい名前を自由入力するか切り替えられる部品
function SchoolField({ value, onChange, schools, placeholder }) {
  const [customMode, setCustomMode] = useState(!!value && !schools.includes(value));

  useEffect(() => {
    // 候補一覧が後から読み込まれた場合、まだ何も入力していなければ一覧モードに切り替える
    if (!value && schools.length>0 && customMode) setCustomMode(false);
  }, [schools]);

  if (customMode) {
    return (
      <div>
        <input style={S.inp} placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)} />
        {schools.length>0 && (
          <button style={{ background:"none",border:"none",color:C.accent,fontSize:11,fontWeight:700,cursor:"pointer",marginTop:4,padding:0 }} onClick={()=>setCustomMode(false)}>← 一覧から選ぶ</button>
        )}
      </div>
    );
  }

  return (
    <select
      style={{ ...S.inp, background:"transparent" }}
      value={schools.includes(value) ? value : ""}
      onChange={e=>{
        if (e.target.value === "__custom__") { setCustomMode(true); }
        else onChange(e.target.value);
      }}
    >
      <option value="">選択してください</option>
      {schools.map(s => <option key={s} value={s}>{s}</option>)}
      <option value="__custom__">＋ 新しい学校名を入力</option>
    </select>
  );
}

// ============================================================
// 試合セットアップ
// ============================================================
function MatchSetup({ onSave, onCancel, sourceMatchId, editMatchId }) {
  const [ready, setReady] = useState(!editMatchId && !sourceMatchId);
  const [editing, setEditing] = useState(null);
  const [source,  setSource]  = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [e, s] = await Promise.all([
        editMatchId ? getMatch(editMatchId) : Promise.resolve(null),
        sourceMatchId ? getMatch(sourceMatchId) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setEditing(e); setSource(s); setReady(true);
    }
    load();
    return () => { cancelled = true; };
  }, [editMatchId, sourceMatchId]);

  if (!ready) {
    return (
      <div style={S.page}>
        <div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div>
      </div>
    );
  }
  return <MatchSetupForm onSave={onSave} onCancel={onCancel} editing={editing} source={source} />;
}

function MatchSetupForm({ onSave, onCancel, editing, source }) {
  const base    = editing || source;

  // 編集モードでは形式設定をロック（試合開始後は変更不可）
  const locked = !!editing;

  const aBase = base ? base.players.find(p=>p.team==="A") : null;
  const aBase2 = base ? base.players.find(p=>p.team==="A" && p.order_num===2) : null;
  const bBase = base ? base.players.find(p=>p.team==="B") : null;
  const bBase2 = base ? base.players.find(p=>p.team==="B" && p.order_num===2) : null;

  // ★各フィールドを独立したstateに分離（フォーカス維持のため）
  const [matchDate,      setMatchDate]      = useState(base?.match_date ?? today());
  const [venue,          setVenue]          = useState(base?.venue ?? "");
  const [tournamentName, setTournamentName] = useState(base?.tournament_name ?? "");
  const [round,          setRound]          = useState(base?.round ?? "");
  const [matchType,      setMatchType]      = useState(base?.match_type ?? "tournament");
  const [gameFormat,     setGameFormat]     = useState(base?.game_format ?? 7);
  const [isDoubles,      setIsDoubles]      = useState(base?.is_doubles ?? true);
  const [firstServer,    setFirstServer]    = useState(base?.first_server ?? "A");
  const [aClub,  setAClub]  = useState(aBase?.club_name ?? "");
  const [aP1,    setAP1]    = useState(aBase?.player_name ?? "");
  const [aP2,    setAP2]    = useState(aBase2?.player_name ?? "");
  const [bClub,  setBClub]  = useState(bBase?.club_name ?? "");
  const [bP1,    setBP1]    = useState(bBase?.player_name ?? "");
  const [bP2,    setBP2]    = useState(bBase2?.player_name ?? "");

  const canSave = aP1.trim() && bP1.trim();

  const [saving, setSaving] = useState(false);

  // ★選手マスター（同じ学校のメンバーで共有）を読み込み、入力時にチップで選べるようにする
  const [roster, setRoster] = useState([]);
  useEffect(() => { getPlayerRoster().then(setRoster); }, []);

  // ★学校名の候補一覧（誤入力防止）
  const [schools, setSchools] = useState([]);
  useEffect(() => { getKnownSchoolNames().then(setSchools); }, []);

  async function handleSave() {
    setSaving(true);
    try {
      if (editing) {
        // 既存試合の試合情報・選手情報のみ更新（スコア・ゲームは変更しない）
        const updatedPlayers = [
          { id: aBase?.id ?? uid(), match_id: editing.id, team:"A", player_name:aP1.trim(), club_name:aClub.trim(), position:aBase?.position ?? null, order_num:1 },
          ...(isDoubles && aP2.trim() ? [{ id: aBase2?.id ?? uid(), match_id: editing.id, team:"A", player_name:aP2.trim(), club_name:aClub.trim(), position:aBase2?.position ?? null, order_num:2 }] : []),
          { id: bBase?.id ?? uid(), match_id: editing.id, team:"B", player_name:bP1.trim(), club_name:bClub.trim(), position:bBase?.position ?? null, order_num:1 },
          ...(isDoubles && bP2.trim() ? [{ id: bBase2?.id ?? uid(), match_id: editing.id, team:"B", player_name:bP2.trim(), club_name:bClub.trim(), position:bBase2?.position ?? null, order_num:2 }] : []),
        ];
        const updated = {
          ...editing,
          match_date:matchDate, venue, tournament_name:tournamentName, round, match_type:matchType,
          players: updatedPlayers,
          // 形式設定（game_format, is_doubles, first_server）はロックのため変更しない
        };
        await saveMatch(updated);
        onSave(editing.id);
        return;
      }

      // 新規作成 or コピー作成
      const mid = uid();
      const players = [
        { id:uid(), match_id:mid, team:"A", player_name:aP1.trim(), club_name:aClub.trim(), position:null, order_num:1 },
        ...(isDoubles && aP2.trim() ? [{ id:uid(), match_id:mid, team:"A", player_name:aP2.trim(), club_name:aClub.trim(), position:null, order_num:2 }] : []),
        { id:uid(), match_id:mid, team:"B", player_name:bP1.trim(), club_name:bClub.trim(), position:null, order_num:1 },
        ...(isDoubles && bP2.trim() ? [{ id:uid(), match_id:mid, team:"B", player_name:bP2.trim(), club_name:bClub.trim(), position:null, order_num:2 }] : []),
      ];
      const match = {
        id:mid, created_by:"me",
        match_date:matchDate, venue, tournament_name:tournamentName, round,
        match_type:matchType, game_format:gameFormat, is_doubles:isDoubles, first_server:firstServer,
        status:"active", match_score_a:0, match_score_b:0, memo:"", players, games:[],
      };
      await saveMatch(match);
      onSave(mid);
    } catch (e) {
      alert("保存に失敗しました: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onCancel}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>{editing?"試合情報を編集":source?"試合をコピー":"新規試合"}</span>
        </div>
      </div>
      {source && (
        <div style={{ background:"#fff8e6",borderBottom:"1px solid #f5d99b",padding:"10px 14px",fontSize:12,color:"#7a5800" }}>
          📋 「{source.tournament_name || "前の試合"}」の情報をコピーしました。内容を確認・変更してください（スコアはコピーされません）。
        </div>
      )}
      {locked && (
        <div style={{ background:"#e3f2fd",borderBottom:"1px solid #90caf9",padding:"10px 14px",fontSize:12,color:"#1565c0" }}>
          ✏️ 試合情報・選手名を編集できます。ゲーム数・種目・サーブ順は試合開始後のため変更できません。
        </div>
      )}
      <div style={{ padding:14 }}>

        <FormSec title="試合情報">
          <FormRow label="試合日">
            <input type="date" style={S.inp} value={matchDate} onChange={e => setMatchDate(e.target.value)}/>
          </FormRow>
          <FormRow label="場所 / 会場名">
            <input style={S.inp} placeholder="例：○○市民コート" value={venue} onChange={e => setVenue(e.target.value)}/>
          </FormRow>
          <FormRow label="大会名">
            <input style={S.inp} placeholder="例：○○中学校選手権" value={tournamentName} onChange={e => setTournamentName(e.target.value)}/>
          </FormRow>
          <FormRow label="何回戦">
            <input style={S.inp} placeholder="例：準々決勝" value={round} onChange={e => setRound(e.target.value)}/>
          </FormRow>
          <FormRow label="試合の種別">
            <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
              {MATCH_TYPES.map(({key,label}) => (
                <button key={key} style={S.togBtn(matchType===key)} onClick={() => setMatchType(key)}>{label}</button>
              ))}
            </div>
          </FormRow>
        </FormSec>

        <FormSec title={locked ? "形式設定（試合開始後は変更不可）" : "形式設定"}>
          <FormRow label="ゲーム数（デフォルト：7G）">
            {locked ? (
              <div style={{ fontSize:14,fontWeight:700,color:C.textSec,padding:"4px 0" }}>{gameFormat}G 🔒</div>
            ) : (
              <div style={{ display:"flex",gap:8 }}>
                {GAME_FORMATS.map(v => (
                  <button key={v} style={S.togBtn(gameFormat===v)} onClick={() => setGameFormat(v)}>{v}G</button>
                ))}
              </div>
            )}
          </FormRow>
          <FormRow label="種目">
            {locked ? (
              <div style={{ fontSize:14,fontWeight:700,color:C.textSec,padding:"4px 0" }}>{isDoubles?"ダブルス":"シングルス"} 🔒</div>
            ) : (
              <div style={{ display:"flex",gap:8 }}>
                {[["ダブルス",true],["シングルス",false]].map(([l,v]) => (
                  <button key={l} style={S.togBtn(isDoubles===v)} onClick={() => setIsDoubles(v)}>{l}</button>
                ))}
              </div>
            )}
          </FormRow>
          <FormRow label="最初のサーブ">
            {locked ? (
              <div style={{ fontSize:14,fontWeight:700,color:C.textSec,padding:"4px 0" }}>{firstServer==="A"?"自チーム":"相手"} 🔒</div>
            ) : (
              <div style={{ display:"flex",gap:8 }}>
                <button style={S.togBtn(firstServer==="A")} onClick={() => setFirstServer("A")}>自チーム</button>
                <button style={S.togBtn(firstServer==="B")} onClick={() => setFirstServer("B")}>相手</button>
              </div>
            )}
          </FormRow>
        </FormSec>

        <FormSec title="自チーム (A)">
          <FormRow label="チーム名 / 学校名">
            <SchoolField value={aClub} onChange={setAClub} schools={schools} placeholder="例：○○中学校" />
          </FormRow>
          <FormRow label={isDoubles ? "選手1" : "選手名"}>
            <input style={S.inp} placeholder="選手名" value={aP1} onChange={e => setAP1(e.target.value)}/>
            {roster.length>0 && (
              <div style={{ marginTop:6 }}>
                {roster.map(p=>(
                  <span key={p.id} style={S.chip(aP1===p.player_name)} onClick={()=>setAP1(p.player_name)}>{p.player_name}</span>
                ))}
              </div>
            )}
          </FormRow>
          {isDoubles && (
            <FormRow label="選手2（ペア）">
              <input style={S.inp} placeholder="選手名" value={aP2} onChange={e => setAP2(e.target.value)}/>
              {roster.length>0 && (
                <div style={{ marginTop:6 }}>
                  {roster.map(p=>(
                    <span key={p.id} style={S.chip(aP2===p.player_name)} onClick={()=>setAP2(p.player_name)}>{p.player_name}</span>
                  ))}
                </div>
              )}
            </FormRow>
          )}
          {roster.length===0 && (
            <div style={{ padding:"0 14px 12px",fontSize:11,color:C.textSec }}>
              ホーム画面の「👥 選手マスター」から選手を登録すると、ここで選んで入力できるようになります。
            </div>
          )}
        </FormSec>

        <FormSec title="相手チーム (B)">
          <FormRow label="チーム名 / 学校名">
            <SchoolField value={bClub} onChange={setBClub} schools={schools} placeholder="例：相手チーム名" />
          </FormRow>
          <FormRow label={isDoubles ? "選手1" : "選手名"}>
            <input style={S.inp} placeholder="選手名" value={bP1} onChange={e => setBP1(e.target.value)}/>
          </FormRow>
          {isDoubles && (
            <FormRow label="選手2（ペア）">
              <input style={S.inp} placeholder="選手名" value={bP2} onChange={e => setBP2(e.target.value)}/>
            </FormRow>
          )}
        </FormSec>

        <button
          style={{ ...S.btn((canSave&&!saving) ? `linear-gradient(135deg,${C.accent},#00a066)` : C.border, (canSave&&!saving) ? C.white : C.textSec), marginTop:4 }}
          disabled={!canSave || saving}
          onClick={handleSave}
        >
          {saving ? "保存中..." : (editing ? "保存する 💾" : "試合を開始する 🎾")}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// スコア記録
// ============================================================
function ScoreRecord({ matchId, onBack, onEdit }) {
  const [initialMatch, setInitialMatch] = useState(null);
  const [loadKey, setLoadKey] = useState(0); // 再読み込みトリガー（編集画面から戻った時など）

  useEffect(() => {
    let cancelled = false;
    getMatch(matchId).then(m => { if (!cancelled) setInitialMatch(m); });
    return () => { cancelled = true; };
  }, [matchId, loadKey]);

  if (!initialMatch) {
    return (
      <div style={S.page}>
        <div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div>
      </div>
    );
  }
  return (
    <ScoreRecordInner
      key={initialMatch.id}
      initialMatch={initialMatch}
      onBack={onBack}
      onEdit={onEdit}
      onReload={()=>setLoadKey(k=>k+1)}
    />
  );
}

function ScoreRecordInner({ initialMatch, onBack, onEdit, onReload }) {
  const [match,  setMatch]  = useState(initialMatch);
  const [tab,    setTab]    = useState("record");
  const [fault,  setFault]  = useState(0);
  const [modal,  setModal]  = useState(null);
  // 4段階選択状態
  const [selPlay,   setSelPlay]   = useState(null);   // プレイ内容
  const [selSide,   setSelSide]   = useState(null);   // フォア / バック
  const [selResult, setSelResult] = useState(null);   // 結果
  const [selPlayer, setSelPlayer] = useState(null);   // 選手（表示名・記録用）
  const [selPlayerId, setSelPlayerId] = useState(null); // 選手（チップ選択状態の判定用・一意ID）
  const [correctMode, setCorrectMode] = useState(false); // 試合終了後のスコア修正モード
  const [editingPoint, setEditingPoint] = useState(null); // 修正中のポイント { gameId, point }
  const [addingPoint, setAddingPoint] = useState(null); // 追加位置 { gameId, atIndex }

  // ★保存処理を1件ずつ順番に実行するためのキュー（連打しても保存が衝突しないように）
  const saveQueueRef = useRef(Promise.resolve());
  const persist = useCallback((m)=>{
    setMatch({...m});
    saveQueueRef.current = saveQueueRef.current
      .then(()=>saveMatch(m))
      .catch(e=>alert("保存に失敗しました: "+(e.message||e)));
  },[]);
  const winGames = calcWinGames(match.game_format);
  const currentGame = match.games.length>0&&!match.games[match.games.length-1].winner_team ? match.games[match.games.length-1] : null;
  const currentGameIsFinal = currentGame ? currentGame.is_final : isFinalGame(match.game_format,match.match_score_a,match.match_score_b);
  const nonFaultPts = currentGame?.points??[];
  const curServer = currentGame ? (currentGame.is_final ? finalServer(currentGame.server_team,nonFaultPts.length) : currentGame.server_team) : null;
  const serverLabel = curServer==="A" ? match.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/") : match.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
  const teamALabel = match.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/");
  const teamBLabel = match.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
  const aClub = match.players.find(p=>p.team==="A")?.club_name??"";
  const bClub = match.players.find(p=>p.team==="B")?.club_name??"";

  function resetSel(){ setSelPlay(null); setSelSide(null); setSelResult(null); setSelPlayer(null); setSelPlayerId(null); }

  function startNewGame(base=match){
    const num=base.games.length+1;
    const isFin=isFinalGame(base.game_format,base.match_score_a,base.match_score_b);
    const srv=gameServer(base.first_server,num);
    const g={id:uid(),match_id:base.id,game_number:num,server_team:srv,is_final:isFin,score_a:0,score_b:0,winner_team:null,points:[],faults:[]};
    persist({...base,games:[...base.games,g]});
  }

  function addPoint(team){
    if(!currentGame) return;
    const cg=currentGame;
    const newA=team==="A"?cg.score_a+1:cg.score_a;
    const newB=team==="B"?cg.score_b+1:cg.score_b;
    const isWin = selResult ? isWinnerResult(selResult) : null;
    const pt={
      id:uid(),game_id:cg.id,match_id:match.id,
      point_number:nonFaultPts.length+1,
      scoring_team:team,
      player_name:selPlayer??null,
      play_type:selPlay??null,
      side_type:selSide??null,
      result_type:selResult??null,
      is_winner:isWin,
      score_a_after:newA, score_b_after:newB,
    };
    const updG={...cg,points:[...cg.points,pt],score_a:newA,score_b:newB};
    const gWin=cg.is_final?checkFinalWinner(newA,newB):checkNormalWinner(newA,newB);
    if(gWin) updG.winner_team=gWin;
    const newMA=match.match_score_a+(gWin==="A"?1:0);
    const newMB=match.match_score_b+(gWin==="B"?1:0);
    const updM={...match,games:match.games.map(g=>g.id===cg.id?updG:g),match_score_a:newMA,match_score_b:newMB};
    resetSel(); setFault(0);
    if(gWin){
      if(newMA>=winGames||newMB>=winGames){ persist({...updM,status:"finished"}); }
      else { persist(updM); setModal({type:"gameOver",winner:gWin,num:cg.game_number,sA:newMA,sB:newMB}); }
    } else { persist(updM); }
  }

  function handleFault(){
    if(!currentGame) return;
    if(fault===0){
      const cg=currentGame;
      const f={id:uid(),game_id:cg.id,match_id:match.id,fault_number:(cg.faults?.length??0)+1,server_team:curServer,player_name:selPlayer??null,score_a_at:cg.score_a,score_b_at:cg.score_b};
      persist({...match,games:match.games.map(g=>g.id===cg.id?{...cg,faults:[...(cg.faults??[]),f]}:g)});
      setFault(1);
    } else {
      setFault(0);
      addPoint(curServer==="A"?"B":"A");
    }
  }

  function undo(){
    if(!currentGame||currentGame.points.length===0) return;
    const cg=currentGame;
    const newPts=cg.points.slice(0,-1);
    const last=newPts[newPts.length-1];
    const updG={...cg,points:newPts,score_a:last?.score_a_after??0,score_b:last?.score_b_after??0,winner_team:null};
    persist({...match,games:match.games.map(g=>g.id===cg.id?updG:g)});
    setFault(0);
  }

  // ★試合終了後、過去の任意のゲームのポイント構成が変わった際にスコア・勝敗を再計算して保存する共通処理
  function applyGamePointsChange(gameId, newPoints){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g) return;
    let a=0, b=0;
    const recalced = newPoints.map((p,i)=>{
      if(p.scoring_team==="A") a++; else b++;
      return {...p, point_number:i+1, score_a_after:a, score_b_after:b};
    });
    const finalA = recalced.length ? recalced[recalced.length-1].score_a_after : 0;
    const finalB = recalced.length ? recalced[recalced.length-1].score_b_after : 0;
    const newWinner = g.is_final ? checkFinalWinner(finalA,finalB) : checkNormalWinner(finalA,finalB);
    const updG = {...g, points:recalced, score_a:finalA, score_b:finalB, winner_team:newWinner};
    const newGames = match.games.map(gm=>gm.id===gameId?updG:gm);
    const newScoreA = newGames.filter(gm=>gm.winner_team==="A").length;
    const newScoreB = newGames.filter(gm=>gm.winner_team==="B").length;
    persist({...match, games:newGames, match_score_a:newScoreA, match_score_b:newScoreB});
  }

  function deletePointFromGame(gameId, pointId){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g) return;
    applyGamePointsChange(gameId, g.points.filter(p=>p.id!==pointId));
  }

  function updatePointInGame(gameId, pointId, updates){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g) return;
    applyGamePointsChange(gameId, g.points.map(p=>p.id===pointId?{...p,...updates}:p));
  }

  // ★試合終了後、過去の任意のゲームの好きな位置にポイントを挿入する
  function insertPointInGame(gameId, atIndex, values){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g) return;
    const newPoint = { id:uid(), game_id:gameId, match_id:match.id, ...values };
    const newPoints = [...g.points.slice(0,atIndex), newPoint, ...g.points.slice(atIndex)];
    applyGamePointsChange(gameId, newPoints);
  }

  const allPlayers = match.players.map(p=>({ id:p.id, name:p.player_name, team:p.team }));

  return (
    <div style={S.page}>
      {/* スコアボードヘッダー */}
      <div style={{ background:`linear-gradient(135deg,${C.navy},${C.navyMid})`, padding:"10px 14px" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <div style={{ textAlign:"center" }}>
            {match.tournament_name&&<div style={{ fontSize:11,color:"rgba(255,255,255,0.8)",fontWeight:700 }}>{match.tournament_name}{match.round?` · ${match.round}`:""}</div>}
            <div style={{ fontSize:10,color:"rgba(255,255,255,0.5)" }}>{fmtDate(match.match_date)}{match.venue?` · ${match.venue}`:""} · {match.game_format}Gマッチ</div>
          </div>
          <button style={{ background:"rgba(255,255,255,0.15)",border:"none",borderRadius:8,color:C.white,fontSize:13,padding:"5px 8px",cursor:"pointer" }} onClick={()=>onEdit&&onEdit(match.id)} title="試合情報を編集">✏️</button>
        </div>

        {/* スコアボード: 行ごとgridで左右高さを統一 */}
        <div style={{ background:"rgba(0,0,0,0.25)",borderRadius:14,padding:"10px 8px" }}>
          {/* サーブ行（固定高さ16px） */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 88px 1fr",gap:8,marginBottom:2 }}>
            <div style={{ textAlign:"center",height:16,display:"flex",alignItems:"center",justifyContent:"center" }}>
              {curServer==="A" && <span style={{ fontSize:9,color:C.serve,fontWeight:700 }}>&#127934; サーブ</span>}
            </div>
            <div/>
            <div style={{ textAlign:"center",height:16,display:"flex",alignItems:"center",justifyContent:"center" }}>
              {curServer==="B" && <span style={{ fontSize:9,color:C.serve,fontWeight:700 }}>&#127934; サーブ</span>}
            </div>
          </div>
          {/* チーム名行（固定高さ16px） */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 88px 1fr",gap:8,marginBottom:2 }}>
            <div style={{ textAlign:"center",height:16,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden" }}>
              <span style={{ fontSize:10,color:"rgba(255,255,255,0.6)",whiteSpace:"nowrap",textOverflow:"ellipsis",overflow:"hidden" }}>{aClub}</span>
            </div>
            <div/>
            <div style={{ textAlign:"center",height:16,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden" }}>
              <span style={{ fontSize:10,color:"rgba(255,255,255,0.6)",whiteSpace:"nowrap",textOverflow:"ellipsis",overflow:"hidden" }}>{bClub}</span>
            </div>
          </div>
          {/* 選手名行（固定高さ20px） */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 88px 1fr",gap:8,marginBottom:6 }}>
            <div style={{ textAlign:"center",minHeight:20,display:"flex",alignItems:"center",justifyContent:"center" }}>
              <span style={{ fontSize:11,fontWeight:700,color:C.white,lineHeight:1.3 }}>{teamALabel}</span>
            </div>
            <div/>
            <div style={{ textAlign:"center",minHeight:20,display:"flex",alignItems:"center",justifyContent:"center" }}>
              <span style={{ fontSize:11,fontWeight:700,color:C.white,lineHeight:1.3 }}>{teamBLabel}</span>
            </div>
          </div>
          {/* 左右=ゲーム内ポイント（大きく）、中央=ゲームカウント（小さく） */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 88px 1fr",gap:8,alignItems:"center" }}>
            {/* 左：自チームの現在ゲームポイント */}
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:56,fontWeight:900,color:C.white,lineHeight:1 }}>
                {currentGame ? currentGame.score_a : "—"}
              </div>
            </div>
            {/* 中央：ゲームカウント（小さく） */}
            <div style={{ textAlign:"center" }}>
              <div style={{ background:"rgba(255,255,255,0.15)",borderRadius:10,padding:"6px 4px" }}>
                <div style={{ fontSize:9,color:"rgba(255,255,255,0.6)",marginBottom:3 }}>
                  {currentGame ? ("G" + currentGame.game_number + (currentGame.is_final ? " F" : "")) : ""}
                </div>
                <div style={{ display:"flex",gap:3,alignItems:"center",justifyContent:"center" }}>
                  <span style={{ fontSize:18,fontWeight:900,color:match.match_score_a>=winGames?"#fbbf24":C.white }}>{match.match_score_a}</span>
                  <span style={{ color:"rgba(255,255,255,0.4)",fontSize:11 }}>-</span>
                  <span style={{ fontSize:18,fontWeight:900,color:match.match_score_b>=winGames?"#fbbf24":C.white }}>{match.match_score_b}</span>
                </div>
                {fault===1 && <div style={{ fontSize:9,color:C.serve,marginTop:2,fontWeight:700 }}>1st F</div>}
              </div>
            </div>
            {/* 右：相手チームの現在ゲームポイント */}
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:56,fontWeight:900,color:C.white,lineHeight:1 }}>
                {currentGame ? currentGame.score_b : "—"}
              </div>
            </div>
          </div>
        </div>

        {/* ゲームバッジ */}
        <div style={{ display:"flex",gap:5,marginTop:8,flexWrap:"wrap",justifyContent:"center" }}>
          {match.games.map(g=>(
            <div key={g.id} style={{ padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:g.winner_team==="A"?C.teamA:g.winner_team==="B"?C.teamB:"rgba(255,255,255,0.2)",color:C.white }}>
              {g.is_final?"🔥":""}G{g.game_number}: {g.score_a}-{g.score_b}
            </div>
          ))}
        </div>
        {currentGameIsFinal&&currentGame&&<div style={{ textAlign:"center",marginTop:6 }}><span style={{ fontSize:10,fontWeight:800,color:C.white,background:"#dc2626",padding:"2px 10px",borderRadius:20 }}>🔥 ファイナルゲーム（7点先取）</span></div>}
      </div>

      {/* タブ */}
      <div style={{ display:"flex",background:C.white,borderBottom:`1px solid ${C.border}` }}>
        {[["record","記録"],["score","スコア"],["stats","スタッツ"]].map(([v,l])=>(
          <button key={v} style={{ flex:1,padding:11,border:"none",cursor:"pointer",background:"transparent",fontWeight:tab===v?700:400,fontSize:14,color:tab===v?C.accent:C.textSec,borderBottom:tab===v?`3px solid ${C.accent}`:"3px solid transparent" }} onClick={()=>setTab(v)}>{l}</button>
        ))}
      </div>

      {/* 記録タブ */}
      {tab==="record"&&(
        <div style={{ padding:"10px 12px 20px" }}>
          {match.games.length===0&&match.status!=="finished"&&(
            <div style={{ textAlign:"center",padding:"40px 0" }}>
              <div style={{ fontSize:36,marginBottom:12 }}>🎾</div>
              <p style={{ color:C.textSec,marginBottom:8 }}>第1ゲームを開始してください</p>
              <p style={{ fontSize:13,color:match.first_server==="A"?C.teamA:C.teamB,fontWeight:700,marginBottom:20 }}>最初のサーブ: {match.first_server==="A"?teamALabel:teamBLabel}</p>
              <button style={S.btn(`linear-gradient(135deg,${C.accent},#00a066)`)} onClick={()=>startNewGame()}>第1ゲーム開始</button>
            </div>
          )}
          {!currentGame&&match.games.length>0&&match.status!=="finished"&&(
            <div style={{ textAlign:"center",padding:"30px 0" }}>
              <p style={{ color:C.textSec,marginBottom:16 }}>ゲーム終了。次のゲームへ</p>
              <button style={S.btn(`linear-gradient(135deg,${C.accent},#00a066)`)} onClick={()=>startNewGame()}>第{match.games.length+1}ゲーム開始</button>
            </div>
          )}
          {match.status==="finished"&&!correctMode&&(
            <div>
              {/* 結果サマリー */}
              <div style={{ textAlign:"center",padding:"24px 0 16px" }}>
                <div style={{ fontSize:52 }}>🏆</div>
                <p style={{ fontSize:18,fontWeight:800,color:C.accent,marginTop:8 }}>試合終了</p>
                <p style={{ fontSize:14,fontWeight:700,color:C.white,marginTop:4,background:C.navy,display:"inline-block",padding:"4px 16px",borderRadius:20 }}>
                  {match.match_score_a>match.match_score_b?teamALabel:teamBLabel} の勝利！
                </p>
              </div>
              {/* ゲーム別スコア一覧（両チームの選手名を表示） */}
              <div style={{ background:C.white,borderRadius:12,border:"1px solid "+C.border,overflow:"hidden",marginBottom:12 }}>
                <div style={{ background:C.navy,padding:"8px 14px",display:"flex",alignItems:"center" }}>
                  <span style={{ flex:1,fontSize:11,fontWeight:700,color:C.white }}>ゲーム別スコア</span>
                  <span style={{ width:74,fontSize:10,fontWeight:700,color:C.teamA,textAlign:"center" }}>{teamALabel}</span>
                  <span style={{ width:74,fontSize:10,fontWeight:700,color:C.teamB,textAlign:"center" }}>{teamBLabel}</span>
                </div>
                {match.games.map(g=>(
                  <div key={g.id} style={{ display:"flex",alignItems:"center",padding:"10px 14px",borderBottom:"1px solid "+C.border }}>
                    <span style={{ fontSize:12,color:C.textSec,width:46 }}>{g.is_final?"🔥":""}G{g.game_number}</span>
                    <span style={{ flex:1,fontSize:15,fontWeight:700,textAlign:"center" }}>
                      <span style={{ color:g.winner_team==="A"?C.teamA:C.textSec }}>{g.score_a}</span>
                      <span style={{ color:C.textSec,margin:"0 8px" }}>-</span>
                      <span style={{ color:g.winner_team==="B"?C.teamB:C.textSec }}>{g.score_b}</span>
                    </span>
                    <span style={{ width:74,textAlign:"center",fontSize:14 }}>{g.winner_team==="A"?"🏆":""}</span>
                    <span style={{ width:74,textAlign:"center",fontSize:14 }}>{g.winner_team==="B"?"🏆":""}</span>
                  </div>
                ))}
                <div style={{ display:"flex",alignItems:"center",padding:"12px 14px",background:C.accentL }}>
                  <span style={{ fontSize:12,fontWeight:700,color:C.navy,width:46 }}>合計</span>
                  <span style={{ flex:1,fontSize:20,fontWeight:900,textAlign:"center" }}>
                    <span style={{ color:match.match_score_a>match.match_score_b?C.teamA:C.textSec }}>{match.match_score_a}</span>
                    <span style={{ color:C.textSec,margin:"0 8px" }}>-</span>
                    <span style={{ color:match.match_score_b>match.match_score_a?C.teamB:C.textSec }}>{match.match_score_b}</span>
                  </span>
                  <span style={{ width:74,textAlign:"center",fontSize:16 }}>{match.match_score_a>match.match_score_b?"🏆":""}</span>
                  <span style={{ width:74,textAlign:"center",fontSize:16 }}>{match.match_score_b>match.match_score_a?"🏆":""}</span>
                </div>
              </div>
              {/* ボタン群 */}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:8 }}>
                <button style={{ ...S.btn(C.navyMid),fontSize:13 }} onClick={()=>setTab("stats")}>📊 スタッツを見る</button>
                <button style={{ ...S.btn(C.navyMid),fontSize:13 }} onClick={()=>setTab("score")}>📋 スコアを見る</button>
              </div>
              <button style={{ ...S.btn("#fff"),color:C.navy,border:"1px solid "+C.border,marginBottom:8 }} onClick={()=>onEdit&&onEdit(match.id)}>✏️ 試合情報を編集</button>
              <button style={{ ...S.btn("#fff"),color:C.orange,border:"1px solid "+C.orange,marginBottom:8 }} onClick={()=>setCorrectMode(true)}>✏️ スコアを修正</button>
              <button style={{ ...S.btn("#06c755"),marginBottom:8 }} onClick={()=>window.open("https://line.me/R/msg/text/?"+encodeURIComponent(buildLineText(match)),"_blank")}>💬 LINEで結果を共有</button>
              <button style={{ ...S.btn("linear-gradient(135deg,"+C.accent+",#00a066)") }} onClick={onBack}>← 試合一覧に戻る</button>
            </div>
          )}

          {match.status==="finished"&&correctMode&&(
            <div>
              <div style={{ background:"#fff3e0",border:"1px solid #ffd699",borderRadius:10,padding:"10px 12px",marginBottom:12,fontSize:12,color:"#7a5800" }}>
                ✏️ 修正したいポイントをタップすると内容の変更・削除ができます。「＋」では好きな位置にポイントを追加できます。
              </div>
              {match.games.map(g=>(
                <div key={g.id} style={S.card}>
                  <div style={{ padding:"8px 12px",background:C.navyMid,color:C.white,display:"flex",justifyContent:"space-between" }}>
                    <span style={{ fontWeight:700,fontSize:13 }}>{g.is_final?"🔥":""}第{g.game_number}ゲーム</span>
                    <span style={{ fontWeight:700 }}>{g.score_a} - {g.score_b}</span>
                  </div>
                  <div style={{ padding:"8px 10px" }}>
                    <div style={{ textAlign:"center" }}>
                      <button style={{ background:"none",border:`1px dashed ${C.border}`,borderRadius:8,color:C.accent,fontSize:11,fontWeight:700,cursor:"pointer",padding:"4px 10px",width:"100%" }} onClick={()=>setAddingPoint({gameId:g.id,atIndex:0})}>＋ 先頭に追加</button>
                    </div>
                    {g.points.length===0&&<div style={{ fontSize:12,color:C.textSec,padding:"10px 4px",textAlign:"center" }}>記録なし</div>}
                    {g.points.map((pt,idx)=>(
                      <div key={pt.id}>
                        <div style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 8px",background:C.gray,borderRadius:8,marginTop:4,borderLeft:`4px solid ${pt.scoring_team==="A"?C.accent:C.orange}`,cursor:"pointer" }} onClick={()=>setEditingPoint({gameId:g.id,point:pt})}>
                          <span style={{ fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20,background:pt.scoring_team==="A"?C.accentL:C.redL,color:pt.scoring_team==="A"?C.accent:C.red,whiteSpace:"nowrap" }}>
                            {pt.scoring_team==="A"?"A 得点":"B 得点"}
                          </span>
                          <span style={{ fontSize:11,flex:1,color:C.text }}>
                            {[pt.player_name,pt.play_type?getPlayLabel(pt.play_type):null,pt.side_type?getSideLabel(pt.side_type):null,pt.result_type?getResultLabel(pt.result_type):null].filter(Boolean).join(" · ")||"—"}
                          </span>
                          <span style={{ fontSize:11,color:C.textSec,whiteSpace:"nowrap" }}>{pt.score_a_after}-{pt.score_b_after}</span>
                          <span style={{ fontSize:14,color:C.textSec,flexShrink:0 }}>›</span>
                        </div>
                        <div style={{ textAlign:"center",marginTop:4 }}>
                          <button style={{ background:"none",border:"none",color:C.accent,fontSize:10,fontWeight:700,cursor:"pointer",padding:"3px 8px" }} onClick={()=>setAddingPoint({gameId:g.id,atIndex:idx+1})}>＋ ここに追加</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`),marginTop:4 }} onClick={()=>setCorrectMode(false)}>修正を完了</button>
            </div>
          )}

          {editingPoint && (
            <PointEditModal
              mode="edit"
              point={editingPoint.point}
              players={allPlayers}
              teamALabel={teamALabel}
              teamBLabel={teamBLabel}
              onClose={()=>setEditingPoint(null)}
              onSave={(updates)=>{ updatePointInGame(editingPoint.gameId, editingPoint.point.id, updates); setEditingPoint(null); }}
              onDelete={()=>{ if(window.confirm("このポイントを削除しますか？削除後はスコアが自動的に再計算されます。")){ deletePointFromGame(editingPoint.gameId, editingPoint.point.id); setEditingPoint(null); } }}
            />
          )}

          {addingPoint && (
            <PointEditModal
              mode="add"
              point={{ scoring_team:"A", play_type:null, side_type:null, result_type:null, player_name:null }}
              players={allPlayers}
              teamALabel={teamALabel}
              teamBLabel={teamBLabel}
              onClose={()=>setAddingPoint(null)}
              onSave={(values)=>{ insertPointInGame(addingPoint.gameId, addingPoint.atIndex, values); setAddingPoint(null); }}
            />
          )}

          {currentGame&&match.status!=="finished"&&(
            <>
              {/* フォルトカウントバー */}
              <div style={{ background:"#fff3e0",border:`1px solid #ffd699`,borderRadius:10,padding:"6px 12px",marginBottom:10,display:"flex",alignItems:"center",gap:8 }}>
                <span style={{ fontSize:11,fontWeight:700,color:"#e65100",flex:1 }}>🎾 {serverLabel} のサーブ</span>
                <span style={{ fontSize:10,color:"#666" }}>1st:</span>
                <div style={{ width:12,height:12,borderRadius:"50%",background:fault>=1?C.orange:C.border }}/>
                <div style={{ width:12,height:12,borderRadius:"50%",background:fault>=2?C.orange:C.border }}/>
                <button style={{ background:fault===1?"#dc2626":C.purple,color:C.white,border:"none",borderRadius:7,fontSize:11,fontWeight:700,padding:"4px 10px",cursor:"pointer" }} onClick={handleFault}>
                  {fault===1?"フォルト→DF":"フォルト"}
                </button>
              </div>

              {/* ★段階1: プレイ内容 */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:8 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>プレイ内容（任意）</div>
                <div>
                  {PLAY_TYPES.map(p=>(
                    <span key={p.key} style={S.chip(selPlay===p.key)} onClick={()=>setSelPlay(selPlay===p.key?null:p.key)}>{p.label}</span>
                  ))}
                </div>
              </div>

              {/* ★段階2: フォア / バック */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:8 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>フォア / バック（任意）</div>
                <div>
                  {SIDE_TYPES.map(s=>(
                    <span key={s.key} style={S.chip(selSide===s.key)} onClick={()=>setSelSide(selSide===s.key?null:s.key)}>{s.label}</span>
                  ))}
                </div>
              </div>

              {/* ★段階3: 結果 */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:8 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>結果（任意）</div>
                <div>
                  {RESULT_TYPES.map(r=>(
                    <span key={r.key} style={S.chip(selResult===r.key)} onClick={()=>setSelResult(selResult===r.key?null:r.key)}>{r.label}</span>
                  ))}
                </div>
              </div>

              {/* ★段階4: 選手 */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:10 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>選手（任意）</div>
                <div>
                  {allPlayers.map(p=>(
                    <span
                      key={p.id}
                      style={S.chip(selPlayerId===p.id)}
                      onClick={()=>{ setSelPlayerId(selPlayerId===p.id?null:p.id); setSelPlayer(selPlayerId===p.id?null:p.name); }}
                    >{p.name}</span>
                  ))}
                </div>
              </div>

              {/* ★得点ボタン（◯✕→「得点」表記に変更） */}
              <div style={{ fontSize:11,color:C.textSec,fontWeight:700,textAlign:"center",marginBottom:8 }}>どちらが得点しましたか？</div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10 }}>
                <button style={{ height:70,background:"#2ecc71",color:C.white,border:"none",borderRadius:14,fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,boxShadow:"0 3px 10px rgba(46,204,113,0.35)" }} onClick={()=>addPoint("A")}>
                  <span style={{ fontSize:22 }}>得点</span>
                  <span style={{ fontSize:11,opacity:0.9 }}>{aClub||"自分たち"}</span>
                </button>
                <button style={{ height:70,background:C.red,color:C.white,border:"none",borderRadius:14,fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,boxShadow:"0 3px 10px rgba(229,57,53,0.35)" }} onClick={()=>addPoint("B")}>
                  <span style={{ fontSize:22 }}>得点</span>
                  <span style={{ fontSize:11,opacity:0.9 }}>{bClub||"相手"}</span>
                </button>
              </div>
              <button style={{ width:"100%",padding:11,background:"#dbeafe",color:"#1565c0",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={undo}>↩ 1つ前に戻す</button>

              {/* 直近記録 */}
              {currentGame.points.length>0&&(
                <div style={{ marginTop:12 }}>
                  <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>直近の記録</div>
                  {[...currentGame.points].reverse().slice(0,5).map(pt=>(
                    <div key={pt.id} style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:C.white,borderRadius:8,marginBottom:4,borderLeft:`4px solid ${pt.scoring_team==="A"?C.accent:C.orange}` }}>
                      <span style={{ fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20,background:pt.scoring_team==="A"?C.accentL:C.redL,color:pt.scoring_team==="A"?C.accent:C.red,whiteSpace:"nowrap" }}>
                        {pt.scoring_team==="A"?"A 得点":"B 得点"}
                      </span>
                      <span style={{ fontSize:11,flex:1,color:C.text }}>
                        {[pt.player_name,pt.play_type?getPlayLabel(pt.play_type):null,pt.side_type?getSideLabel(pt.side_type):null,pt.result_type?getResultLabel(pt.result_type):null].filter(Boolean).join(" · ")||"—"}
                      </span>
                      <span style={{ fontSize:11,color:C.textSec,whiteSpace:"nowrap" }}>{pt.score_a_after}-{pt.score_b_after}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* スコアタブ */}
      {tab==="score"&&(
        <div style={{ padding:12 }}>
          {match.games.map(g=>(
            <div key={g.id} style={S.card}>
              <div style={{ padding:"8px 12px",background:g.winner_team==="A"?C.teamA:g.winner_team==="B"?C.teamB:C.accent,color:C.white,display:"flex",justifyContent:"space-between" }}>
                <span style={{ fontWeight:700,fontSize:13 }}>{g.is_final?"🔥":""}第{g.game_number}ゲーム</span>
                <span style={{ fontWeight:700 }}>{g.score_a} - {g.score_b}</span>
              </div>
              <div style={{ padding:"10px 12px" }}>
                <div style={{ display:"flex",gap:3,flexWrap:"wrap",marginBottom:8 }}>
                  {g.points.map(pt=>(
                    <div key={pt.id} title={[pt.player_name,pt.play_type?getPlayLabel(pt.play_type):"",pt.side_type?getSideLabel(pt.side_type):"",pt.result_type?getResultLabel(pt.result_type):""].filter(Boolean).join(" ")} style={{ width:22,height:22,borderRadius:5,background:pt.scoring_team==="A"?C.teamA:C.teamB,display:"flex",alignItems:"center",justifyContent:"center",cursor:"default" }}>
                      <span style={{ fontSize:9,color:C.white,fontWeight:700 }}>{pt.scoring_team}</span>
                    </div>
                  ))}
                </div>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ borderCollapse:"collapse",minWidth:280,fontSize:10 }}>
                    <tbody>
                      {[["A",teamALabel],["B",teamBLabel]].map(([team,name])=>(
                        <tr key={team}>
                          <td style={{ fontSize:10,color:team==="A"?C.teamA:C.teamB,fontWeight:700,paddingRight:8,whiteSpace:"nowrap" }}>{name}</td>
                          {g.points.map((pt,i)=>(
                            <td key={i} style={{ padding:"2px 4px",textAlign:"center",background:pt.scoring_team===team?(team==="A"?C.teamA+"18":C.teamB+"18"):"transparent",minWidth:28 }}>
                              {pt.scoring_team===team&&(
                                <div>
                                  <div style={{ fontSize:10,fontWeight:700,color:team==="A"?C.teamA:C.teamB }}>{pt.score_a_after}-{pt.score_b_after}</div>
                                  {pt.play_type&&<div style={{ fontSize:8,color:C.textSec }}>{getPlayLabel(pt.play_type).slice(0,4)}</div>}
                                </div>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* スタッツタブ */}
      {tab==="stats"&&<StatsTab match={match} onDownloadCsv={()=>downloadCsv(match)} onShareLine={()=>window.open(`https://line.me/R/msg/text/?${encodeURIComponent(buildLineText(match))}`,"_blank")}/>}

      {modal?.type==="gameOver"&&(
        <Modal>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:44 }}>🎾</div>
            <h3 style={{ fontSize:18,fontWeight:800,margin:"8px 0" }}>第{modal.num}ゲーム終了！</h3>
            <p style={{ color:C.textSec }}>{modal.winner==="A"?teamALabel:teamBLabel} 勝利</p>
            <div style={{ fontSize:28,fontWeight:900,margin:"10px 0" }}><span style={{ color:C.teamA }}>{modal.sA}</span><span style={{ color:C.textSec,margin:"0 8px" }}>-</span><span style={{ color:C.teamB }}>{modal.sB}</span></div>
            <button style={S.btn(`linear-gradient(135deg,${C.accent},#00a066)`)} onClick={()=>{setModal(null);startNewGame();}}>次のゲームへ</button>
          </div>
        </Modal>
      )}

    </div>
  );
}

// ============================================================
// スタッツタブ（★相手チームスタッツのバグ修正）
// ============================================================
function StatsTab({ match, onDownloadCsv, onShareLine }) {
  const [teamFilter, setTeamFilter] = useState("A");
  const stats    = calcPlayerStats(match);
  const comments = calcAutoComment(stats, teamFilter);
  // ★修正: teamFilterで絞る（Bも正しく表示）
  const filtered = stats.filter(s => s.team === teamFilter);

  const allPts = match.games.flatMap(g => g.points);
  const totalA = allPts.filter(p=>p.scoring_team==="A").length;
  const totalB = allPts.filter(p=>p.scoring_team==="B").length;
  const winA   = allPts.filter(p=>p.scoring_team==="A"&&p.is_winner===true).length;
  const winB   = allPts.filter(p=>p.scoring_team==="B"&&p.is_winner===true).length;

  function Bar({ a, b, label }) {
    const max = Math.max(a, b, 1);
    const pctA = Math.round((a / max) * 100);
    const pctB = Math.round((b / max) * 100);
    return (
      <div style={{ marginBottom:12 }}>
        {/* 数値ラベル行 */}
        <div style={{ display:"flex", alignItems:"center", marginBottom:4 }}>
          <span style={{ fontSize:13, fontWeight:700, color:C.teamA, width:28, textAlign:"left" }}>{a}</span>
          <span style={{ flex:1, fontSize:11, color:C.textSec, textAlign:"center" }}>{label}</span>
          <span style={{ fontSize:13, fontWeight:700, color:C.teamB, width:28, textAlign:"right" }}>{b}</span>
        </div>
        {/* バー行：左=自チームA（右寄せ）、中央区切り、右=相手B（左寄せ） */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 2px 1fr", alignItems:"center", height:8, gap:2 }}>
          {/* A側：右寄せ */}
          <div style={{ display:"flex", justifyContent:"flex-end", height:8, background:"#e8edf3", borderRadius:"4px 0 0 4px", overflow:"hidden" }}>
            <div style={{ width:`${pctA}%`, background:C.teamA, height:"100%", borderRadius:"4px 0 0 4px", transition:"width 0.3s" }}/>
          </div>
          {/* 中央区切り線 */}
          <div style={{ width:2, height:14, background:C.border }}/>
          {/* B側：左寄せ */}
          <div style={{ display:"flex", justifyContent:"flex-start", height:8, background:"#e8edf3", borderRadius:"0 4px 4px 0", overflow:"hidden" }}>
            <div style={{ width:`${pctB}%`, background:C.teamB, height:"100%", borderRadius:"0 4px 4px 0", transition:"width 0.3s" }}/>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:14 }}>
      {/* チーム比較 */}
      <div style={{ background:C.white,borderRadius:12,border:`1px solid ${C.border}`,padding:14,marginBottom:12 }}>
        <div style={{ display:"flex",justifyContent:"space-between",marginBottom:12 }}>
          <span style={{ fontSize:12,fontWeight:700,color:C.teamA }}>自チーム</span>
          <span style={{ fontSize:11,color:C.textSec }}>チーム比較</span>
          <span style={{ fontSize:12,fontWeight:700,color:C.teamB }}>相手チーム</span>
        </div>
        <Bar a={totalA} b={totalB} label="総ポイント"/>
        <Bar a={winA}   b={winB}   label="ウィナー"/>
        <Bar a={totalA-winA} b={totalB-winB} label="相手ミス"/>
      </div>

      {/* ★自チーム/相手チーム切替タブ */}
      <div style={{ display:"flex",background:"#f0f2f6",padding:3,borderRadius:10,marginBottom:12 }}>
        {[["A","自チーム"],["B","相手チーム"]].map(([t,l])=>(
          <button key={t} style={{ flex:1,padding:7,border:"none",cursor:"pointer",borderRadius:8,fontSize:12,fontWeight:700,background:teamFilter===t?C.white:"transparent",color:teamFilter===t?C.navy:C.textSec,boxShadow:teamFilter===t?"0 1px 4px rgba(0,0,0,0.1)":"none" }} onClick={()=>setTeamFilter(t)}>{l}</button>
        ))}
      </div>

      {/* ★選手別スタッツ（filtered で正しくBも表示） */}
      {filtered.length===0&&(
        <div style={{ textAlign:"center",color:C.textSec,padding:"30px 0" }}>
          <div style={{ fontSize:32,marginBottom:8 }}>📊</div>
          選手データがありません<br/>
          <span style={{ fontSize:12 }}>ポイント記録時に選手を選択すると表示されます</span>
        </div>
      )}
      {filtered.map(p=>{
        const topPlays = Object.entries(p.plays).sort((a,b)=>b[1]-a[1]).slice(0,4);
        return (
          <div key={`${p.team}__${p.player_name}`} style={{ ...S.card,marginBottom:10 }}>
            <div style={{ background:p.team==="A"?C.navyMid:C.navy,padding:"8px 12px",display:"flex",alignItems:"center",gap:8 }}>
              <div style={{ width:26,height:26,borderRadius:"50%",background:p.team==="A"?C.teamA:C.teamB,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:C.white }}>{p.player_name[0]}</div>
              <span style={{ fontSize:13,fontWeight:700,color:C.white,flex:1 }}>{p.player_name}</span>
              <span style={{ fontSize:10,color:"#8099cc" }}>計 {p.total}pt</span>
            </div>
            <div style={{ padding:12 }}>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:10 }}>
                {[["得点",p.winners,C.accent],["ミス",p.errors,C.red],["得点率",p.total>0?`${Math.round(p.winners/p.total*100)}%`:"—",C.orange]].map(([l,v,c])=>(
                  <div key={l} style={{ background:`${c}11`,borderRadius:8,padding:"8px 4px",textAlign:"center" }}>
                    <div style={{ fontSize:18,fontWeight:700,color:c }}>{v}</div>
                    <div style={{ fontSize:9,color:C.textSec,fontWeight:700 }}>{l}</div>
                  </div>
                ))}
              </div>
              {/* プレイ内容内訳 */}
              {topPlays.length>0&&<div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>プレイ内容の内訳</div>}
              {topPlays.map(([k,n])=>{
                const isWin=p.results["winner"]>0||p.results["ace"]>0;
                return (
                  <div key={k} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                    <span style={{ fontSize:10,color:C.textSec,width:80,flexShrink:0 }}>{k==="fault"?"1stフォルト":getPlayLabel(k)}</span>
                    <div style={{ flex:1,height:6,background:C.border,borderRadius:3 }}><div style={{ width:`${Math.round(n/p.total*100)}%`,height:"100%",background:C.accent,borderRadius:3 }}/></div>
                    <span style={{ fontSize:11,fontWeight:700,color:C.navy,width:28,textAlign:"right" }}>{n}回</span>
                  </div>
                );
              })}
              {/* 結果内訳 */}
              {Object.keys(p.results).length>0&&(
                <>
                  <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6,marginTop:8 }}>結果の内訳</div>
                  {Object.entries(p.results).map(([k,n])=>{
                    const iw=isWinnerResult(k);
                    return (
                      <div key={k} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                        <span style={{ fontSize:10,color:C.textSec,width:80,flexShrink:0 }}>{getResultLabel(k)}</span>
                        <div style={{ flex:1,height:6,background:C.border,borderRadius:3 }}><div style={{ width:`${Math.round(n/(p.total||1)*100)}%`,height:"100%",background:iw===false?C.red:C.accent,borderRadius:3 }}/></div>
                        <span style={{ fontSize:11,fontWeight:700,color:C.navy,width:28,textAlign:"right" }}>{n}回</span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        );
      })}

      {/* 自動コメント */}
      {comments.length>0&&(
        <div style={{ marginBottom:16 }}>
          {comments.map((c,i)=>(
            <div key={i} style={{ background:c.type==="strength"?C.accentL:c.type==="warning"?"#fff3cd":C.redL,border:`1px solid ${c.type==="strength"?C.accent:c.type==="warning"?"#f5a623":C.red}`,borderRadius:10,padding:"10px 12px",marginBottom:8 }}>
              <div style={{ fontSize:11,fontWeight:700,color:c.type==="strength"?C.accent:c.type==="warning"?"#7a5800":C.red,marginBottom:3 }}>{c.type==="strength"?"💪 強み":"⚠️ 課題"} — {c.player}</div>
              <p style={{ fontSize:12,color:C.navy,lineHeight:1.6 }}>{c.text}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
        <button style={S.btn("#06c755")} onClick={onShareLine}>💬 LINEで結果を共有</button>
        <button style={S.btn(C.navy)} onClick={onDownloadCsv}>📊 CSVをダウンロード</button>
      </div>
    </div>
  );
}

// ============================================================
// App Root
// ============================================================
// ============================================================
// 都道府県リスト（プロフィール登録用）
// ============================================================
const PREFECTURES = [
  "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県",
  "茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県",
  "新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県",
  "三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
  "鳥取県","島根県","岡山県","広島県","山口県",
  "徳島県","香川県","愛媛県","高知県",
  "福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県",
];

// 区分（プロフィール・新規登録共通）
const CATEGORY_OPTIONS = [
  { key: "adult",       label: "社会人"   },
  { key: "university",  label: "大学"     },
  { key: "high_school", label: "高校"     },
  { key: "junior_high", label: "中学校"   },
  { key: "elementary",  label: "小学校"   },
  { key: "other",       label: "その他"   },
];

// ============================================================
// プロフィール編集画面
// ============================================================
function ProfileScreen({ onBack }) {
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [prefecture, setPrefecture] = useState("東京都");
  const [category, setCategory] = useState(null);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [schools, setSchools] = useState([]);

  useEffect(() => { getKnownSchoolNames().then(setSchools); }, []);

  useEffect(() => {
    let cancelled = false;
    getMyProfile().then(p => {
      if (cancelled) return;
      if (p) {
        setName(p.name ?? "");
        setSchoolName(p.school_name ?? "");
        setPrefecture(p.prefecture ?? "東京都");
        setCategory(p.category ?? null);
      }
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    setErrorMsg("");
    if (!name.trim()) { setErrorMsg("お名前を入力してください"); return; }
    if (!schoolName.trim()) { setErrorMsg("学校名を入力してください"); return; }
    if (!category) { setErrorMsg("区分を選択してください"); return; }
    setSaving(true);
    try {
      await saveMyProfile({ name: name.trim(), school_name: schoolName.trim(), prefecture, category });
      onBack();
    } catch (e) {
      setErrorMsg(e.message || "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  if (!ready) {
    return (
      <div style={S.page}>
        <div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>プロフィール</span>
        </div>
      </div>
      <div style={{ padding:14 }}>
        <FormSec title="基本情報">
          <FormRow label="お名前">
            <input style={S.inp} value={name} onChange={e=>setName(e.target.value)} />
          </FormRow>
          <FormRow label="都道府県">
            <select style={{ ...S.inp, background:"transparent" }} value={prefecture} onChange={e=>setPrefecture(e.target.value)}>
              {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </FormRow>
          <FormRow label="学校名またはチーム名">
            <SchoolField value={schoolName} onChange={setSchoolName} schools={schools} placeholder="例：○○中学校" />
          </FormRow>
          <FormRow label="区分">
            <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
              {CATEGORY_OPTIONS.map(c => (
                <button key={c.key} style={S.togBtn(category===c.key)} onClick={()=>setCategory(c.key)}>{c.label}</button>
              ))}
            </div>
          </FormRow>
        </FormSec>

        <div style={{ background:"#e3f2fd",border:"1px solid #90caf9",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#1565c0",marginBottom:12 }}>
          ℹ️ 学校名を変更すると、共有される試合・選手マスターの範囲が変わります。
        </div>

        {errorMsg && (
          <div style={{ background:C.redL, color:C.red, fontSize:12, padding:"10px 14px", borderRadius:10, marginBottom:12, fontWeight:700 }}>⚠️ {errorMsg}</div>
        )}

        <button
          style={{ ...S.btn(saving ? C.border : `linear-gradient(135deg,${C.accent},#00a066)`), color: saving?C.textSec:C.white }}
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? "保存中..." : "保存する"}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// 選手マスター画面（同じ学校のメンバーで共有）
// ============================================================
function PlayerRosterScreen({ onBack }) {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newPosition, setNewPosition] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editPosition, setEditPosition] = useState("");

  const reload = useCallback(() => {
    setLoading(true);
    getPlayerRoster().then(list => { setPlayers(list); setLoading(false); });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function handleAdd() {
    if (!newName.trim()) return;
    await savePlayer({ player_name: newName.trim(), position: newPosition.trim() });
    setNewName(""); setNewPosition("");
    reload();
  }

  async function handleUpdate(id) {
    if (!editName.trim()) return;
    await savePlayer({ id, player_name: editName.trim(), position: editPosition.trim() });
    setEditingId(null);
    reload();
  }

  async function handleDelete(id) {
    if (!window.confirm("この選手をマスターから削除しますか？")) return;
    await deletePlayerFromRoster(id);
    reload();
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>選手マスター</span>
        </div>
      </div>
      <div style={{ padding:14 }}>
        <div style={{ background:"#e3f2fd",border:"1px solid #90caf9",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#1565c0",marginBottom:14 }}>
          ℹ️ ここで登録した選手は、同じ学校のメンバー全員が試合作成時に選べます。
        </div>

        <FormSec title="選手を追加">
          <FormRow label="選手名">
            <input style={S.inp} placeholder="例：田中 蓮" value={newName} onChange={e=>setNewName(e.target.value)} />
          </FormRow>
          <FormRow label="ポジション（任意）">
            <input style={S.inp} placeholder="例：前衛" value={newPosition} onChange={e=>setNewPosition(e.target.value)} />
          </FormRow>
        </FormSec>
        <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), marginBottom:16 }} onClick={handleAdd}>＋ 追加する</button>

        {loading && <div style={{ textAlign:"center",color:C.textSec,padding:"20px 0" }}>読み込み中...</div>}
        {!loading && players.length===0 && <div style={{ textAlign:"center",color:C.textSec,padding:"20px 0" }}>登録されている選手がいません</div>}

        {players.map(p => (
          <div key={p.id} style={S.card}>
            {editingId===p.id ? (
              <div style={{ padding:12 }}>
                <input style={{ ...S.inp, marginBottom:8 }} value={editName} onChange={e=>setEditName(e.target.value)} />
                <input style={{ ...S.inp, marginBottom:10 }} placeholder="ポジション" value={editPosition} onChange={e=>setEditPosition(e.target.value)} />
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                  <button style={{ ...S.btn("#f0f0f0"),color:C.text,fontSize:12 }} onClick={()=>setEditingId(null)}>キャンセル</button>
                  <button style={{ ...S.btn(C.accent),fontSize:12 }} onClick={()=>handleUpdate(p.id)}>保存</button>
                </div>
              </div>
            ) : (
              <div style={{ display:"flex",alignItems:"center",padding:"12px 14px",gap:10 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14,fontWeight:700,color:C.text }}>{p.player_name}</div>
                  {p.position && <div style={{ fontSize:11,color:C.textSec }}>{p.position}</div>}
                </div>
                <button style={{ background:"none",border:"none",fontSize:16,cursor:"pointer" }} onClick={()=>{ setEditingId(p.id); setEditName(p.player_name); setEditPosition(p.position||""); }}>✏️</button>
                <button style={{ background:"none",border:"none",fontSize:16,cursor:"pointer",color:C.red }} onClick={()=>handleDelete(p.id)}>🗑</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// ログイン／新規登録画面
// ============================================================
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("login"); // login | signup
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [name,        setName]        = useState("");
  const [schoolName,  setSchoolName]  = useState("");
  const [prefecture,  setPrefecture]  = useState("東京都");
  const [category,    setCategory]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [schools, setSchools] = useState([]);

  useEffect(() => { getKnownSchoolNames().then(setSchools); }, []);


  async function handleLogin() {
    setErrorMsg("");
    if (!email.trim()) { setErrorMsg("メールアドレスを入力してください"); return; }
    if (password.length < 6) { setErrorMsg("パスワードは6文字以上で入力してください"); return; }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      onAuthed();
    } catch (e) {
      setErrorMsg(e.message === "Invalid login credentials" ? "メールアドレスまたはパスワードが違います" : (e.message || "ログインに失敗しました"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup() {
    setErrorMsg("");
    if (!email.trim()) { setErrorMsg("メールアドレスを入力してください"); return; }
    if (password.length < 6) { setErrorMsg("パスワードは6文字以上で入力してください"); return; }
    if (!name.trim()) { setErrorMsg("お名前を入力してください"); return; }
    if (!schoolName.trim()) { setErrorMsg("学校名を入力してください"); return; }
    if (!category) { setErrorMsg("区分を選択してください"); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
      if (error) throw error;
      if (data.user) {
        const { error: profileErr } = await supabase.from("users").insert({
          id: data.user.id,
          name: name.trim(),
          school_name: schoolName.trim(),
          prefecture,
          category,
        });
        if (profileErr) throw profileErr;
      }
      onAuthed();
    } catch (e) {
      setErrorMsg(e.message || "登録に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ ...S.page, display:"flex", flexDirection:"column", justifyContent:"center", padding:"24px 20px" }}>
      <div style={{ textAlign:"center", marginBottom:28 }}>
        <div style={{ fontSize:44, marginBottom:8 }}>🎾</div>
        <div style={{ fontSize:20, fontWeight:800, color:C.navy }}>ソフトテニス記録アプリ</div>
        <div style={{ fontSize:12, color:C.textSec, marginTop:4 }}>スコア記録・データ分析</div>
      </div>

      {/* タブ切替 */}
      <div style={{ display:"flex", background:"#f0f2f6", padding:3, borderRadius:10, marginBottom:18 }}>
        {[["login","ログイン"],["signup","新規登録"]].map(([v,l]) => (
          <button key={v} style={{ flex:1, padding:9, border:"none", cursor:"pointer", borderRadius:8, fontSize:13, fontWeight:700, background:mode===v?C.white:"transparent", color:mode===v?C.navy:C.textSec, boxShadow:mode===v?"0 1px 4px rgba(0,0,0,0.1)":"none" }} onClick={()=>{ setMode(v); setErrorMsg(""); }}>{l}</button>
        ))}
      </div>

      <div style={S.card}>
        <div style={{ padding:"14px 16px" }}>
          <label style={S.lbl}>メールアドレス</label>
          <input type="email" style={S.inp} placeholder="example@email.com" value={email} onChange={e=>setEmail(e.target.value)} autoCapitalize="none"/>
        </div>
        <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
          <label style={S.lbl}>パスワード（6文字以上）</label>
          <input type="password" style={S.inp} placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)}/>
        </div>

        {mode==="signup" && (
          <>
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>お名前</label>
              <input style={S.inp} placeholder="例：田中 蓮" value={name} onChange={e=>setName(e.target.value)}/>
            </div>
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>都道府県</label>
              <select style={{ ...S.inp, background:"transparent" }} value={prefecture} onChange={e=>setPrefecture(e.target.value)}>
                {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>学校名またはチーム名</label>
              <SchoolField value={schoolName} onChange={setSchoolName} schools={schools} placeholder="例：○○中学校" />
            </div>
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>区分</label>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {CATEGORY_OPTIONS.map(c => (
                  <button key={c.key} style={S.togBtn(category===c.key)} onClick={()=>setCategory(c.key)}>{c.label}</button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {errorMsg && (
        <div style={{ background:C.redL, color:C.red, fontSize:12, padding:"10px 14px", borderRadius:10, marginTop:12, fontWeight:700 }}>
          ⚠️ {errorMsg}
        </div>
      )}

      <button
        style={{ ...S.btn(mode==="login" ? `linear-gradient(135deg,${C.accent},#00a066)` : C.navy), marginTop:16, opacity:loading?0.6:1 }}
        disabled={loading}
        onClick={mode==="login" ? handleLogin : handleSignup}
      >
        {loading ? "処理中..." : (mode==="login" ? "ログイン" : "新規登録する")}
      </button>
    </div>
  );
}

export default function App() {
  // ログイン状態の確認
  const [authChecked, setAuthChecked] = useState(false);
  const [user,        setUser]        = useState(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setAuthChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const [screen,       setScreen]       = useState("list");
  const [matchId,      setMatchId]      = useState(null);
  const [copySourceId, setCopySourceId] = useState(null); // コピー元の試合ID
  const [editTargetId, setEditTargetId] = useState(null); // 編集対象の試合ID
  const [tick,         setTick]         = useState(0);

  // ログイン状態確認中は簡易ローディング表示
  if (!authChecked) {
    return (
      <div style={{ ...S.page, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ textAlign:"center", color:C.textSec }}>
          <div style={{ fontSize:36, marginBottom:8 }}>🎾</div>
          読み込み中...
        </div>
      </div>
    );
  }

  // 未ログインならログイン画面へ
  if (!user) {
    return <AuthScreen onAuthed={()=>{}} />;
  }

  if (screen==="profile") {
    return <ProfileScreen onBack={()=>setScreen("list")} />;
  }
  if (screen==="roster") {
    return <PlayerRosterScreen onBack={()=>setScreen("list")} />;
  }

  if (screen==="setup") {
    return (
      <MatchSetup
        sourceMatchId={copySourceId}
        editMatchId={editTargetId}
        onSave={id=>{
          setCopySourceId(null);
          if (editTargetId) {
            // 編集完了後は記録画面に戻る
            setEditTargetId(null);
            setMatchId(id);
            setScreen("record");
          } else {
            setMatchId(id);
            setScreen("record");
          }
        }}
        onCancel={()=>{
          setCopySourceId(null);
          if (editTargetId) {
            // 編集キャンセル時は記録画面に戻る
            const back = editTargetId;
            setEditTargetId(null);
            setMatchId(back);
            setScreen("record");
          } else {
            setScreen("list");
          }
        }}
      />
    );
  }
  if (screen==="record"&&matchId) {
    return (
      <ScoreRecord
        key={matchId+tick}
        matchId={matchId}
        onBack={()=>{setScreen("list");setTick(t=>t+1);setMatchId(null);}}
        onEdit={id=>{ setEditTargetId(id); setScreen("setup"); }}
      />
    );
  }
  return (
    <MatchList
      key={tick}
      onNew={()=>{ setCopySourceId(null); setEditTargetId(null); setScreen("setup"); }}
      onOpen={id=>{setMatchId(id);setScreen("record");}}
      onCopy={id=>{ setCopySourceId(id); setEditTargetId(null); setScreen("setup"); }}
      onProfile={()=>setScreen("profile")}
      onRoster={()=>setScreen("roster")}
    />
  );
}
