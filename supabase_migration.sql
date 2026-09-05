-- =======================================================
-- ⚡ OrbiBot - Migración a Multi-Tenant
-- =======================================================
-- Ejecuta este script SOLO si ya tienes la tabla orbibot_settings creada
-- con el esquema anterior (key TEXT PRIMARY KEY sin streamer_id).
--
-- Este script migrará tus datos existentes sin perderlos.
-- Ejecuta en: https://supabase.com/dashboard/project/pzrlfuzjkwkrnmqkoaue/sql

-- 1. Agregar columna streamer_id a la tabla existente
ALTER TABLE public.orbibot_settings 
ADD COLUMN IF NOT EXISTS streamer_id TEXT NOT NULL DEFAULT 'default';

-- 2. Eliminar la clave primaria anterior (key sola)
ALTER TABLE public.orbibot_settings DROP CONSTRAINT IF EXISTS orbibot_settings_pkey;

-- 3. Crear nueva clave primaria compuesta (streamer_id + key)
ALTER TABLE public.orbibot_settings ADD PRIMARY KEY (streamer_id, key);

-- 4. Índice para búsquedas rápidas por streamer
CREATE INDEX IF NOT EXISTS idx_orbibot_streamer ON public.orbibot_settings(streamer_id);

-- ✅ Migración completada. Los datos existentes ahora están bajo streamer_id = 'default'.
-- OrbiBot asignará automáticamente el streamer_id correcto cuando el streamer se autentique.
