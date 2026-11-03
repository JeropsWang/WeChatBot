-- 017_hunt_gallery：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- hunt_references：登记内置及上传参考图，内容摘要用于去重，软删除保留历史版本可解释性。
CREATE TABLE hunt_references (
  -- id：文本参考图ID；兼容固定内置ID及上传生成ID，不能强转UUID。
  id text PRIMARY KEY,
  -- name：显示名称；便于管理员辨认，不能作为稳定身份或权限凭据。
  name text NOT NULL,
  -- source：builtin/upload由CHECK限定；决定是否允许删除和如何展示来源。
  source text NOT NULL CHECK(source IN ('builtin','upload')),
  -- category：业务分类；用于筛选与检索组织，不授予权限。
  category text NOT NULL,
  -- path：本地图像源文件位置；数据库不是图片二进制备份。
  path text NOT NULL,
  -- crop：可空裁剪坐标JSON；只比较指定区域，NULL表示使用全图。
  crop jsonb,
  -- digest：源图字节摘要；上传资源部分唯一索引用于去重，不能用于判断消息重复。
  digest text NOT NULL,
  -- thumbnail：缩略图本地路径；管理端预览与原文件分离。
  thumbnail text NOT NULL,
  -- deleted_at：软删除时间；NULL表示当前可选，历史图库仍可能引用文件。
  deleted_at timestamptz,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hunt_reference_upload_digest ON hunt_references(digest) WHERE source='upload';
-- hunt_galleries：保存不可变图库版本及其文件清单，任务固定引用生成时所用图库。
CREATE TABLE hunt_galleries(
  -- version：不可变图库版本ID（text）；用于任务固定参考集合，不是递增SQL迁移号。
  version text PRIMARY KEY,
  -- manifest：该版本参考图清单文件路径；历史版本不能随当前选择原地覆盖。
  manifest text NOT NULL,
  -- reference_ids：该版本启用参考ID的JSON数组；空数组支持初装无素材且追猎关闭。
  reference_ids jsonb NOT NULL,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
