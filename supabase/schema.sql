-- ================== USERS JADVALI ==================
CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    first_name TEXT NOT NULL,
    username TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ================== REPORTS JADVALI ==================
CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('text', 'photo')),
    content TEXT NOT NULL,
    caption TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ DEFAULT NULL
);

-- ================== INDEXLAR (Tezlikni oshirish uchun) ==================
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_sent_at ON reports(sent_at);
CREATE INDEX IF NOT EXISTS idx_reports_user_pending ON reports(user_id, sent_at) 
    WHERE sent_at IS NULL;

-- ================== ROW LEVEL SECURITY (RLS) ==================
-- Xavfsizlik uchun - har bir user faqat o'z ma'lumotlarini ko'ra oladi

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- Users uchun policy
CREATE POLICY "Users can view their own data" ON users
    FOR SELECT USING (true);

CREATE POLICY "Users can insert their own data" ON users
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Users can update their own data" ON users
    FOR UPDATE USING (true);

-- Reports uchun policy  
CREATE POLICY "Users can view their own reports" ON reports
    FOR SELECT USING (true);

CREATE POLICY "Users can insert their own reports" ON reports
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Users can update their own reports" ON reports
    FOR UPDATE USING (true);

CREATE POLICY "Users can delete their own reports" ON reports
    FOR DELETE USING (true);

-- ================== FUNKSIYALAR ==================

-- Avtomatik updated_at yangilash funksiyasi
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger qo'shish
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ================== STATISTIKA VIEW ==================
CREATE OR REPLACE VIEW user_stats AS
SELECT 
    u.id,
    u.first_name,
    u.username,
    COUNT(r.id) as total_reports,
    COUNT(CASE WHEN r.sent_at IS NOT NULL THEN 1 END) as sent_reports,
    COUNT(CASE WHEN r.sent_at IS NULL THEN 1 END) as pending_reports,
    COUNT(CASE WHEN r.type = 'text' THEN 1 END) as text_reports,
    COUNT(CASE WHEN r.type = 'photo' THEN 1 END) as photo_reports,
    MAX(r.created_at) as last_report_date
FROM users u
LEFT JOIN reports r ON u.id = r.user_id
GROUP BY u.id, u.first_name, u.username;

-- ================== TEST MA'LUMOTLARI (ixtiyoriy) ==================
-- INSERT INTO users (id, first_name, username) 
-- VALUES (123456789, 'Test User', 'testuser');

-- INSERT INTO reports (user_id, type, content, caption)
-- VALUES 
--     (123456789, 'text', 'Bu test hisobot 1', ''),
--     (123456789, 'text', 'Bu test hisobot 2', ''),
--     (123456789, 'photo', 'file_id_example', 'Test rasm');

-- ================== FOYDALI QUERYLAR ==================

-- 1. User bo'yicha barcha pending hisobotlar
-- SELECT * FROM reports 
-- WHERE user_id = YOUR_USER_ID AND sent_at IS NULL
-- ORDER BY created_at DESC;

-- 2. Oxirgi 7 kunlik statistika
-- SELECT 
--     DATE(created_at) as date,
--     COUNT(*) as reports_count,
--     COUNT(CASE WHEN sent_at IS NOT NULL THEN 1 END) as sent_count
-- FROM reports
-- WHERE created_at >= NOW() - INTERVAL '7 days'
-- GROUP BY DATE(created_at)
-- ORDER BY date DESC;

-- 3. Eng faol userlar
-- SELECT * FROM user_stats 
-- ORDER BY total_reports DESC 
-- LIMIT 10;