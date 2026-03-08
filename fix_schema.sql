-- Run this in Supabase SQL Editor
-- Fixes ai_chats table + RLS so new chats can be created

-- 1. Make sure ai_chats has all needed columns
create table if not exists ai_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  title text default 'New Chat',
  last_message text default '',
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Add columns if they already exist but are missing
alter table ai_chats add column if not exists last_message text default '';
alter table ai_chats add column if not exists updated_at timestamptz default now();

-- 2. Make sure ai_messages exists
create table if not exists ai_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references ai_chats(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz default now()
);

-- 3. RLS for ai_chats
alter table ai_chats enable row level security;
drop policy if exists "ai_chats_select" on ai_chats;
drop policy if exists "ai_chats_insert" on ai_chats;
drop policy if exists "ai_chats_update" on ai_chats;
drop policy if exists "ai_chats_delete" on ai_chats;
create policy "ai_chats_select" on ai_chats for select using (auth.uid() = user_id);
create policy "ai_chats_insert" on ai_chats for insert with check (auth.uid() = user_id);
create policy "ai_chats_update" on ai_chats for update using (auth.uid() = user_id);
create policy "ai_chats_delete" on ai_chats for delete using (auth.uid() = user_id);

-- 4. RLS for ai_messages
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

-- 5. Profiles RLS
alter table profiles enable row level security;
drop policy if exists "profiles_select" on profiles;
drop policy if exists "profiles_insert" on profiles;
drop policy if exists "profiles_update" on profiles;
create policy "profiles_select" on profiles for select using (true);
create policy "profiles_insert" on profiles for insert with check (auth.uid() = id);
create policy "profiles_update" on profiles for update using (auth.uid() = id);

select 'Done! All tables and RLS policies set up.' as result;
