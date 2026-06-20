// ============================================================
// Supabase接続レイヤー
// ============================================================
// このファイルは SoftTennisApp.jsx の中の
// 「インメモリストア」セクション（saveMatch / getMatches / getMatch / deleteMatch）
// を置き換えるためのコードです。
//
// 【使い方】
// 1. npm install @supabase/supabase-js を実行
// 2. このファイルの SUPABASE_URL と SUPABASE_ANON_KEY を
//    あなたのSupabaseプロジェクトの値に書き換える
// 3. SoftTennisApp.jsx の冒頭に
//      import { saveMatch, getMatches, getMatch, deleteMatch } from './supabase-client';
//    を追加し、元のインメモリ版の同名関数（60〜139行目あたり）を削除する
// ============================================================

import { createClient } from '@supabase/supabase-js';

// ---- ここをあなたのSupabaseプロジェクトの値に置き換えてください ----
const SUPABASE_URL = 'https://otqagaqntplqotaucsae.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TjZsIqGxrKng6i2oX6BQSw_b-Lv2-a_';
// --------------------------------------------------------------

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// 試合を1件取得（選手・ゲーム・ポイント・フォルトをすべて含めて返す）
// アプリ側が期待する形 { id, ..., players: [...], games: [{ ...points: [...], faults: [...] }] }
// に組み立てて返す
// ============================================================
export async function getMatch(matchId) {
  const { data: match, error: matchErr } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .single();
  if (matchErr || !match) return null;

  const { data: players } = await supabase
    .from('match_players')
    .select('*')
    .eq('match_id', matchId)
    .order('order_num', { ascending: true });

  const { data: games } = await supabase
    .from('games')
    .select('*')
    .eq('match_id', matchId)
    .order('game_number', { ascending: true });

  const gamesWithDetail = [];
  for (const g of games ?? []) {
    const { data: points } = await supabase
      .from('points')
      .select('*')
      .eq('game_id', g.id)
      .order('point_number', { ascending: true });

    const { data: faults } = await supabase
      .from('faults')
      .select('*')
      .eq('game_id', g.id)
      .order('fault_number', { ascending: true });

    gamesWithDetail.push({
      ...g,
      score_a: g.score_a,
      score_b: g.score_b,
      is_final: g.is_final,
      winner_team: g.winner_team,
      points: (points ?? []).map(p => ({
        ...p,
        score_a_after: p.score_a_after,
        score_b_after: p.score_b_after,
      })),
      faults: (faults ?? []).map(f => ({
        ...f,
        score_a_at: f.score_a_at,
        score_b_at: f.score_b_at,
      })),
    });
  }

  return {
    ...match,
    match_score_a: match.match_score_a,
    match_score_b: match.match_score_b,
    players: players ?? [],
    games: gamesWithDetail,
  };
}

// ============================================================
// 試合一覧を取得（カード表示に必要な情報のみ軽量取得）
// ============================================================
export async function getMatches() {
  const { data: matches, error } = await supabase
    .from('matches')
    .select('*')
    .order('match_date', { ascending: false });
  if (error || !matches) return [];

  // 各試合の選手情報をまとめて取得（N+1を避けるため一括取得）
  const matchIds = matches.map(m => m.id);
  const { data: allPlayers } = await supabase
    .from('match_players')
    .select('*')
    .in('match_id', matchIds);

  return matches.map(m => ({
    ...m,
    players: (allPlayers ?? []).filter(p => p.match_id === m.id),
    games: [], // 一覧画面ではゲーム詳細は不要
  }));
}

// ============================================================
// 試合を保存（新規作成 / 更新の両方に対応）
// アプリ側の match オブジェクト（players, games を含むネスト構造）を
// 正規化されたテーブルに分解して書き込む
// ============================================================
export async function saveMatch(match) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('ログインしていません');

  // 1. matches テーブルへ upsert
  const { error: matchErr } = await supabase.from('matches').upsert({
    id: match.id,
    created_by: user.id,
    match_date: match.match_date,
    venue: match.venue || null,
    tournament_name: match.tournament_name || null,
    round: match.round || null,
    match_type: match.match_type,
    game_format: match.game_format,
    is_doubles: match.is_doubles,
    first_server: match.first_server,
    status: match.status,
    match_score_a: match.match_score_a,
    match_score_b: match.match_score_b,
    memo: match.memo || null,
  });
  if (matchErr) throw matchErr;

  // 2. match_players を upsert
  if (match.players?.length) {
    const { error: playersErr } = await supabase.from('match_players').upsert(
      match.players.map(p => ({
        id: p.id,
        match_id: match.id,
        team: p.team,
        player_name: p.player_name,
        user_id: p.user_id || null,
        club_name: p.club_name || null,
        position: p.position || null,
        order_num: p.order_num,
      }))
    );
    if (playersErr) throw playersErr;
  }

  // 3. games / points / faults を upsert
  //    新しく追加された行のみを書き込む（既存行は変更しない設計でもOKだが、
  //    シンプルにするため毎回 upsert する）
  for (const g of match.games ?? []) {
    const { error: gameErr } = await supabase.from('games').upsert({
      id: g.id,
      match_id: match.id,
      game_number: g.game_number,
      server_team: g.server_team,
      is_final: g.is_final,
      score_a: g.score_a,
      score_b: g.score_b,
      winner_team: g.winner_team || null,
    });
    if (gameErr) throw gameErr;

    if (g.points?.length) {
      const { error: pointsErr } = await supabase.from('points').upsert(
        g.points.map(pt => ({
          id: pt.id,
          game_id: g.id,
          match_id: match.id,
          point_number: pt.point_number,
          scoring_team: pt.scoring_team,
          player_name: pt.player_name || null,
          shot_type: pt.play_type && pt.result_type ? pt.play_type + '_' + pt.result_type : (pt.play_type || pt.result_type || null),
          is_winner: pt.is_winner,
          stroke_side: pt.stroke_side || null,
          shot_zone: pt.shot_zone || null,
          score_a_after: pt.score_a_after,
          score_b_after: pt.score_b_after,
        }))
      );
      if (pointsErr) throw pointsErr;
    }

    if (g.faults?.length) {
      const { error: faultsErr } = await supabase.from('faults').upsert(
        g.faults.map(f => ({
          id: f.id,
          game_id: g.id,
          match_id: match.id,
          fault_number: f.fault_number,
          server_team: f.server_team,
          player_name: f.player_name || null,
          score_a_at: f.score_a_at,
          score_b_at: f.score_b_at,
        }))
      );
      if (faultsErr) throw faultsErr;
    }
  }

  return match;
}

// ============================================================
// 試合を削除（games/points/faults/match_players は
// ON DELETE CASCADE 設定済みなので matches を消すだけで連動削除される）
// ============================================================
export async function deleteMatch(matchId) {
  const { error } = await supabase.from('matches').delete().eq('id', matchId);
  if (error) throw error;
}

// ============================================================
// 認証関連のヘルパー（ログイン状態の確認・ログイン・ログアウト）
// ============================================================
export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function signInWithEmail(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signUpWithEmail(email, password, profile) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  if (data.user) {
    // users テーブルにプロフィールを作成
    await supabase.from('users').insert({
      id: data.user.id,
      name: profile.name,
      school_name: profile.school_name,
      prefecture: profile.prefecture,
      category: profile.category,
    });
  }
  return data.user;
}

export async function signOut() {
  await supabase.auth.signOut();
}
