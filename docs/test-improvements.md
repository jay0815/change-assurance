# 测试改进待办事项

## 低优先级改进

### 1. loadPolicy mock 调用参数验证

**文件**: `packages/cli/src/__tests__/review-prepare.test.ts`
**行号**: 21

**问题**: loadPolicy mock 工作正常，但未验证调用参数。

**改进方案**:
```typescript
// 添加调用参数验证
const { loadPolicy } = await import("../policy.js");
expect(loadPolicy).toHaveBeenCalledWith(tempDir);
```

### 2. 二进制文件 status 硬编码

**文件**: `packages/core/src/git.ts`
**行号**: 62

**问题**: `getChangedFiles` 实现中 status 硬编码为 `'modified'`，但 `ChangedFile` 类型支持 `'added' | 'modified' | 'deleted' | 'renamed'`。

**改进方案**:
- 使用 `git diff --name-status` 获取文件状态
- 或在测试中添加注释说明这是当前实现行为

### 3. timestamp 格式验证

**文件**: `packages/core/src/__tests__/git.test.ts`
**行号**: 173

**问题**: `collectGitState` 的 dirty working tree 测试未验证 timestamp 格式。

**改进方案**:
```typescript
expect(state.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
```

## 已完成的改进

- ✅ loadPolicy mock 添加
- ✅ mockReset 调用添加
- ✅ artifact 文件内容验证
- ✅ hash 字段一致性验证（diffHash, changedFilesHash, policySnapshotHash, gitStateHash）
- ✅ execFileSync 参数验证
- ✅ collectGitState 改为 mockImplementation
- ✅ 二进制文件场景测试
- ✅ 尾部换行处理测试
- ✅ GitError 透传行为测试
- ✅ dirty working tree 测试
