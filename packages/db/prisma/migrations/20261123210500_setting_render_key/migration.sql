-- Rendered media (photos, 360° video, live 3D) for a setting, made by apps/ring-lab.
ALTER TABLE "virtual_settings" ADD COLUMN     "renderKey" TEXT;

-- "<collection>/<combo>": it becomes part of a URL path, so only lower-case letters, digits and dashes.
ALTER TABLE "virtual_settings" ADD CONSTRAINT "virtual_settings_render_key_format"
  CHECK ("renderKey" IS NULL OR "renderKey" ~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$');
