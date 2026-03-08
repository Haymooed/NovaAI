-- ── Fix RLS for ai_chats and ai_messages ──────────────────
-- Run this in Supabase SQL Editor if new chats aren't saving

-- ai_chats
alter table ai_chats enable row level security;

drop policy if exists "ai_chats_select" on ai_chats;
drop policy if exists "ai_chats_insert" on ai_chats;
drop policy if exists "ai_chats_update" on ai_chats;
drop policy if exists "ai_chats_delete" on ai_chats;

create policy "ai_chats_select" on ai_chats for select using (auth.uid() = user_id);
create policy "ai_chats_insert" on ai_chats for insert with check (auth.uid() = user_id);
create policy "ai_chats_update" on ai_chats for update using (auth.uid() = user_id);
create policy "ai_chats_delete" on ai_chats for delete using (auth.uid() = user_id);

-- ai_messages
alter table ai_messages enable row level security;

drop policy if exists "ai_messages_select" on ai_messages;
drop policy if exists "ai_messages_insert" on ai_messages;
drop policy if exists "ai_messages_delete" on ai_messages;

create policy "ai_messages_select" on ai_messages for select using (
  exists (select 1 from ai_chats where id = chat_id and user_id = auth.uid())
);
create policy "ai_messages_insert" on ai_messages for insert with check (
  exists (select 1 from ai_chats where id = chat_id and user_id = auth.uid())
);
create policy "ai_messages_delete" on ai_messages for delete using (
  exists (select 1 from ai_chats where id = chat_id and user_id = auth.uid())
);

-- profiles (needed for reading your own profile)
alter table profiles enable row level security;

drop policy if exists "profiles_select" on profiles;
drop policy if exists "profiles_insert" on profiles;
drop policy if exists "profiles_update" on profiles;

create policy "profiles_select" on profiles for select using (true);
create policy "profiles_insert" on profiles for insert with check (auth.uid() = id);
create policy "profiles_update" on profiles for update using (auth.uid() = id);

select 'RLS policies applied successfully' as result;
