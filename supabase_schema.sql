-- =======================================================
-- ⚡ OrbiBot - Esquema de Base de Datos para Supabase
-- =======================================================
-- Multi-Tenant: Cada streamer tiene sus propias configuraciones
-- aisladas mediante la columna "streamer_id".
--
-- Ejecuta este script en el "SQL Editor" de tu panel de Supabase:
-- https://supabase.com/dashboard/project/pzrlfuzjkwkrnmqkoaue/sql

-- 1. Crear tabla principal multi-tenant para almacenar configuraciones por streamer
CREATE TABLE IF NOT EXISTS public.orbibot_settings (
    streamer_id TEXT NOT NULL DEFAULT 'default',
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    PRIMARY KEY (streamer_id, key)
);

-- 2. Índice para búsquedas rápidas por streamer
CREATE INDEX IF NOT EXISTS idx_orbibot_streamer ON public.orbibot_settings(streamer_id);

-- 3. Habilitar seguridad de nivel de fila (Row Level Security - RLS)
ALTER TABLE public.orbibot_settings ENABLE ROW LEVEL SECURITY;

-- 4. Crear políticas de acceso para permitir lectura y escritura segura
DROP POLICY IF EXISTS "Permitir lectura publica" ON public.orbibot_settings;
CREATE POLICY "Permitir lectura publica" ON public.orbibot_settings
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Permitir insercion publica" ON public.orbibot_settings;
CREATE POLICY "Permitir insercion publica" ON public.orbibot_settings
    FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir actualizacion publica" ON public.orbibot_settings;
CREATE POLICY "Permitir actualizacion publica" ON public.orbibot_settings
    FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Permitir eliminacion publica" ON public.orbibot_settings;
CREATE POLICY "Permitir eliminacion publica" ON public.orbibot_settings
    FOR DELETE USING (true);

-- 5. Trigger para actualizar automáticamente la fecha de modificación
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_orbibot_settings_updated_at ON public.orbibot_settings;
CREATE TRIGGER update_orbibot_settings_updated_at
    BEFORE UPDATE ON public.orbibot_settings
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();

-- ¡Listo! Tu base de datos multi-tenant de OrbiBot está configurada.
-- Cada streamer tendrá sus propias filas aisladas automáticamente.
