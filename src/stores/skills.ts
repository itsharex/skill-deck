// src/stores/skills.ts
import { create } from 'zustand';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { useContextStore } from './context';
import {
  listSkills,
  listAgents,
  removeSkill as apiRemoveSkill,
  getSkillAgentDetails as apiGetAgentDetails,
  checkUpdates,
  updateSkill as apiUpdateSkill,
  openInstallWizard,
  checkSkillAudit,
} from '@/hooks/useTauriApi';
import type { AgentInfo, AgentType, InstalledSkill, SkillScope, SkillUpdateInfo, SkillAuditData, SkillAgentDetails } from '@/bindings';

/** 按名称排序 skills，保证展示顺序稳定 */
function sortSkills(skills: InstalledSkill[]): InstalledSkill[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

/** 将 check_updates 结果合并到 skills 列表 */
function mergeUpdateInfo(skills: InstalledSkill[], updates: SkillUpdateInfo[]): InstalledSkill[] {
  const updateMap = new Map(updates.map((u) => [u.name, u.hasUpdate]));
  return skills.map((s) => ({
    ...s,
    hasUpdate: updateMap.get(s.name) ?? false,
  }));
}

/** 更新检测结果的 scope 级缓存 — 避免频繁切换 scope 时重复网络请求 */
const updateInfoCache = new Map<string, { results: SkillUpdateInfo[]; checkedAt: number }>();
const UPDATE_CHECK_TTL = 5 * 60 * 1000; // 5 分钟

/** i18n t() 的便捷包装 */
function t(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options);
}

export interface DeleteTarget {
  skill: InstalledSkill;
  scope: SkillScope;
  projectPath?: string;
}

export interface AddDialogPrefill {
  source: string;
  skillName: string;
}

interface SkillsState {
  // 数据层
  globalSkills: InstalledSkill[];
  projectSkills: InstalledSkill[];
  projectPathExists: boolean;
  allAgents: AgentInfo[];
  loading: boolean;
  error: string | null;

  // 审计数据缓存（key = skillName）
  auditCache: Record<string, SkillAuditData>;

  // 操作层
  isSyncing: boolean;
  /** 正在检测更新的 scope key 集合（'global' | 项目路径） */
  checkingUpdateScopes: Set<string>;
  updatingSkills: Map<string, 'queued' | 'updating' | 'done' | 'failed'>;
  updateAllCancelled: boolean;

  // Dialog 触发状态
  detailSkill: InstalledSkill | null;
  deleteTarget: DeleteTarget | null;
  agentDetails: SkillAgentDetails | null;
  loadingAgentDetails: boolean;

  // Actions — 内部通过 useContextStore.getState() 获取 selectedContext
  fetchSkills: () => Promise<void>;
  syncSkills: () => Promise<void>;
  syncUpdates: () => Promise<void>;
  forceCheckUpdates: (scope: SkillScope) => Promise<void>;
  fetchAuditForSkills: (skills: InstalledSkill[]) => Promise<void>;
  updateSkill: (skillName: string, scope: SkillScope) => Promise<void>;
  updateAllInSection: (scope: SkillScope) => Promise<void>;
  cancelUpdateAll: () => void;
  deleteSkill: (params: { fullRemoval: boolean; agents?: AgentType[] }) => Promise<void>;
  openDetail: (skill: InstalledSkill) => void;
  closeDetail: () => void;
  openDelete: (skill: InstalledSkill, scope: SkillScope, projectPath?: string) => void;
  closeDelete: () => void;
  openAdd: (scope: SkillScope) => void;
  openAddWithPrefill: (prefill: AddDialogPrefill) => void;
}

export const useSkillsStore = create<SkillsState>()((set, get) => ({
  // 数据层初始值
  globalSkills: [],
  projectSkills: [],
  projectPathExists: true,
  allAgents: [],
  loading: true,
  error: null,

  // 审计缓存
  auditCache: {},

  // 操作层初始值
  isSyncing: false,
  checkingUpdateScopes: new Set(),
  updatingSkills: new Map(),
  updateAllCancelled: false,

  // Dialog 初始值
  detailSkill: null,
  deleteTarget: null,
  agentDetails: null,
  loadingAgentDetails: false,

  // === Actions ===

  fetchSkills: async () => {
    const { selectedContext } = useContextStore.getState();
    const isProjectSelected = selectedContext !== 'global';

    try {
      set({ loading: true, error: null });

      if (isProjectSelected) {
        const [agents, globalResult, projectResult] = await Promise.all([
          listAgents(),
          listSkills({ scope: 'global' }),
          listSkills({ scope: 'project', projectPath: selectedContext }),
        ]);
        // 立刻应用缓存的更新检测结果 — 切回 scope 时徽标瞬间出现
        const globalCache = updateInfoCache.get('global');
        const projectCache = updateInfoCache.get(selectedContext);
        set({
          allAgents: agents,
          globalSkills: sortSkills(
            globalCache ? mergeUpdateInfo(globalResult.skills, globalCache.results) : globalResult.skills
          ),
          projectSkills: sortSkills(
            projectCache ? mergeUpdateInfo(projectResult.skills, projectCache.results) : projectResult.skills
          ),
          projectPathExists: projectResult.pathExists,
        });
      } else {
        const [agents, globalResult] = await Promise.all([
          listAgents(),
          listSkills({ scope: 'global' }),
        ]);
        const globalCache = updateInfoCache.get('global');
        set({
          allAgents: agents,
          globalSkills: sortSkills(
            globalCache ? mergeUpdateInfo(globalResult.skills, globalCache.results) : globalResult.skills
          ),
          projectSkills: [],
          projectPathExists: true,
        });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load skills' });
    } finally {
      set({ loading: false });
    }
  },

  fetchAuditForSkills: async (skills: InstalledSkill[]) => {
    // 按 source 分组，批量请求审计数据 — js-index-maps 规则
    const bySource = new Map<string, string[]>();
    for (const skill of skills) {
      if (!skill.source) continue;
      const existing = bySource.get(skill.source);
      if (existing) {
        existing.push(skill.name);
      } else {
        bySource.set(skill.source, [skill.name]);
      }
    }

    // 并行请求所有 source 的审计数据 — async-parallel 规则
    const results = await Promise.all(
      Array.from(bySource.entries()).map(([source, skillNames]) =>
        checkSkillAudit(source, skillNames).catch(() => null)
      )
    );

    const newCache: Record<string, SkillAuditData> = { ...get().auditCache };
    for (const result of results) {
      if (!result) continue;
      for (const [name, data] of Object.entries(result)) {
        if (data) newCache[name] = data;
      }
    }
    set({ auditCache: newCache });
  },

  syncSkills: async () => {
    const { selectedContext } = useContextStore.getState();
    const isProjectSelected = selectedContext !== 'global';

    set({ isSyncing: true });
    try {
      if (isProjectSelected) {
        const [globalResult, projectResult] = await Promise.all([
          listSkills({ scope: 'global' }),
          listSkills({ scope: 'project', projectPath: selectedContext }),
        ]);
        // 仅刷新列表，从缓存只读恢复 hasUpdate 标记
        const globalCache = updateInfoCache.get('global');
        const projectCache = updateInfoCache.get(selectedContext);
        set({
          globalSkills: sortSkills(
            globalCache ? mergeUpdateInfo(globalResult.skills, globalCache.results) : globalResult.skills
          ),
          projectSkills: sortSkills(
            projectCache ? mergeUpdateInfo(projectResult.skills, projectCache.results) : projectResult.skills
          ),
          projectPathExists: projectResult.pathExists,
        });
      } else {
        const globalResult = await listSkills({ scope: 'global' });
        const globalCache = updateInfoCache.get('global');
        set({
          globalSkills: sortSkills(
            globalCache ? mergeUpdateInfo(globalResult.skills, globalCache.results) : globalResult.skills
          ),
          projectSkills: [],
          projectPathExists: true,
        });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to sync skills' });
    } finally {
      set({ isSyncing: false });
    }
  },

  syncUpdates: async () => {
    const contextAtStart = useContextStore.getState().selectedContext;
    const isProjectSelected = contextAtStart !== 'global';

    // TTL 检查 — 缓存未过期则跳过网络请求
    const now = Date.now();
    const globalCache = updateInfoCache.get('global');
    const projectCache = isProjectSelected ? updateInfoCache.get(contextAtStart) : null;
    const globalFresh = globalCache && (now - globalCache.checkedAt) < UPDATE_CHECK_TTL;
    const projectFresh = !isProjectSelected || (projectCache && (now - projectCache.checkedAt) < UPDATE_CHECK_TTL);
    if (globalFresh && projectFresh) return; // 全部新鲜，跳过

    // 按 scope 独立设置 checking 状态
    const scopesToCheck: string[] = [];
    if (!globalFresh) scopesToCheck.push('global');
    if (!projectFresh) scopesToCheck.push(contextAtStart);
    set((state) => {
      const next = new Set(state.checkingUpdateScopes);
      for (const s of scopesToCheck) next.add(s);
      return { checkingUpdateScopes: next };
    });
    try {
      if (isProjectSelected) {
        // 仅请求过期的 scope
        const [globalUpdates, projectUpdates] = await Promise.all([
          globalFresh
            ? globalCache!.results
            : checkUpdates('global').catch(() => [] as SkillUpdateInfo[]),
          projectFresh
            ? projectCache!.results
            : checkUpdates('project', contextAtStart).catch(() => [] as SkillUpdateInfo[]),
        ]);
        if (useContextStore.getState().selectedContext !== contextAtStart) return;
        // 写入缓存
        if (!globalFresh) updateInfoCache.set('global', { results: globalUpdates, checkedAt: now });
        if (!projectFresh) updateInfoCache.set(contextAtStart, { results: projectUpdates, checkedAt: now });
        set((state) => ({
          globalSkills: sortSkills(mergeUpdateInfo(state.globalSkills, globalUpdates)),
          projectSkills: sortSkills(mergeUpdateInfo(state.projectSkills, projectUpdates)),
        }));
      } else {
        const globalUpdates = globalFresh
          ? globalCache!.results
          : await checkUpdates('global').catch(() => [] as SkillUpdateInfo[]);
        if (useContextStore.getState().selectedContext !== contextAtStart) return;
        if (!globalFresh) updateInfoCache.set('global', { results: globalUpdates, checkedAt: now });
        set((state) => ({
          globalSkills: sortSkills(mergeUpdateInfo(state.globalSkills, globalUpdates)),
        }));
      }
    } catch {
      // 静默失败 — 更新检测是非关键路径
    } finally {
      set((state) => {
        const next = new Set(state.checkingUpdateScopes);
        for (const s of scopesToCheck) next.delete(s);
        return { checkingUpdateScopes: next };
      });
    }
  },

  forceCheckUpdates: async (scope: SkillScope) => {
    const { selectedContext } = useContextStore.getState();
    const isGlobal = scope === 'global';
    const cacheKey = isGlobal ? 'global' : selectedContext;

    set((state) => {
      const next = new Set(state.checkingUpdateScopes);
      next.add(cacheKey);
      return { checkingUpdateScopes: next };
    });

    try {
      const projectPath = isGlobal ? undefined : selectedContext;
      const updates = await checkUpdates(scope, projectPath).catch(() => [] as SkillUpdateInfo[]);
      const now = Date.now();
      updateInfoCache.set(cacheKey, { results: updates, checkedAt: now });

      if (isGlobal) {
        set((state) => ({
          globalSkills: sortSkills(mergeUpdateInfo(state.globalSkills, updates)),
        }));
      } else {
        set((state) => ({
          projectSkills: sortSkills(mergeUpdateInfo(state.projectSkills, updates)),
        }));
      }
    } catch {
      // 静默失败
    } finally {
      set((state) => {
        const next = new Set(state.checkingUpdateScopes);
        next.delete(cacheKey);
        return { checkingUpdateScopes: next };
      });
    }
  },

  updateSkill: async (skillName: string, scope: SkillScope) => {
    const { updatingSkills } = get();
    if (updatingSkills.has(skillName)) return;

    const { selectedContext } = useContextStore.getState();
    const projectPath = scope === 'project' ? selectedContext : undefined;

    set((state) => {
      const next = new Map(state.updatingSkills);
      next.set(skillName, 'updating');
      return { updatingSkills: next };
    });

    try {
      const response = await apiUpdateSkill({ scope, name: skillName, projectPath });
      const item = response.results.find((r) => r.name === skillName) ?? response.results[0];
      const agentResults = item?.agentResults ?? [];
      const succeededAgents = agentResults.filter((r) => r.status === 'success').length;
      const failedAgents = agentResults.filter((r) => r.status === 'failed');
      const failedAgentNames = failedAgents.map((r) => r.agent).join(', ');

      if (!item || item.status === 'success') {
        toast.success(t('skills.updateSuccess', { name: skillName }));
      } else if (item.status === 'partial') {
        toast.warning(t('skills.updatePartial', { name: skillName, success: succeededAgents, total: agentResults.length, failed: failedAgents.length, failedAgents: failedAgentNames }));
      } else if (item.status === 'skipped') {
        toast.warning(t('skills.updateSkipped', { name: skillName }));
      } else {
        toast.error(t('skills.updateError', { name: skillName, error: item.error ?? t('skills.updateFailedUnknown') }));
      }

      if (item?.warnings?.length) {
        toast.warning(t('skills.updateWarning', { name: skillName, count: item.warnings.length, detail: item.warnings[0] }));
      }

      set((state) => {
        const next = new Map(state.updatingSkills);
        next.set(skillName, 'done');
        return { updatingSkills: next };
      });
      setTimeout(() => {
        set((state) => {
          const next = new Map(state.updatingSkills);
          next.delete(skillName);
          return { updatingSkills: next };
        });
      }, 800);

      await get().syncSkills();
    } catch (e) {
      toast.error(t('skills.updateError', { name: skillName, error: e instanceof Error ? e.message : String(e) }));
      set((state) => {
        const next = new Map(state.updatingSkills);
        next.set(skillName, 'failed');
        return { updatingSkills: next };
      });
      setTimeout(() => {
        set((state) => {
          const next = new Map(state.updatingSkills);
          next.delete(skillName);
          return { updatingSkills: next };
        });
      }, 2000);
    }
  },

  updateAllInSection: async (scope: SkillScope) => {
    const { globalSkills, projectSkills } = get();
    const skills = scope === 'project' ? projectSkills : globalSkills;
    const updatable = skills.filter((s) => s.hasUpdate);
    if (updatable.length === 0) return;

    set({ updateAllCancelled: false });
    set((state) => {
      const next = new Map(state.updatingSkills);
      for (const s of updatable) { next.set(s.name, 'queued'); }
      return { updatingSkills: next };
    });

    const results: { name: string; success: boolean }[] = [];

    for (const skill of updatable) {
      if (get().updateAllCancelled) {
        set((state) => {
          const next = new Map(state.updatingSkills);
          for (const [name, status] of next) {
            if (status === 'queued') next.delete(name);
          }
          return { updatingSkills: next };
        });
        break;
      }

      set((state) => {
        const next = new Map(state.updatingSkills);
        next.set(skill.name, 'updating');
        return { updatingSkills: next };
      });

      const { selectedContext } = useContextStore.getState();
      const projectPath = scope === 'project' ? selectedContext : undefined;

      try {
        const response = await apiUpdateSkill({ scope, name: skill.name, projectPath });
        const item = response.results.find((r) => r.name === skill.name) ?? response.results[0];
        const success = !item || item.status === 'success' || item.status === 'partial';
        results.push({ name: skill.name, success });
        set((state) => {
          const next = new Map(state.updatingSkills);
          next.set(skill.name, success ? 'done' : 'failed');
          return { updatingSkills: next };
        });
      } catch {
        results.push({ name: skill.name, success: false });
        set((state) => {
          const next = new Map(state.updatingSkills);
          next.set(skill.name, 'failed');
          return { updatingSkills: next };
        });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failedItems = results.filter((r) => !r.success);
    const failedPart = failedItems.length > 0
      ? t('skills.updateAllFailed', { failed: failedItems.length, failedNames: failedItems.map((r) => r.name).join(', ') })
      : '';
    toast.info(t('skills.updateAllSummary', { total: results.length, succeeded, failedPart }));

    setTimeout(() => {
      set((state) => {
        const next = new Map(state.updatingSkills);
        for (const [name, status] of next) {
          if (status === 'done' || status === 'failed') next.delete(name);
        }
        return { updatingSkills: next };
      });
    }, 1500);

    await get().syncSkills();
  },

  cancelUpdateAll: () => { set({ updateAllCancelled: true }); },

  deleteSkill: async ({ fullRemoval, agents }) => {
    const { deleteTarget } = get();
    if (!deleteTarget) return;

    try {
      await apiRemoveSkill({
        scope: deleteTarget.scope,
        name: deleteTarget.skill.name,
        projectPath: deleteTarget.projectPath,
        fullRemoval,
        agents,
      });
      const msg = fullRemoval
        ? t('skills.deleteSuccess', { name: deleteTarget.skill.name })
        : t('skills.partialDeleteSuccess', { name: deleteTarget.skill.name, count: agents?.length ?? 0 });
      toast.success(msg);
      set({ deleteTarget: null, agentDetails: null });
      await get().fetchSkills();
    } catch (e) {
      toast.error(t('skills.deleteError', {
        name: deleteTarget.skill.name,
        error: e instanceof Error ? e.message : String(e),
      }));
      set({ deleteTarget: null, agentDetails: null });
    }
  },

  // Dialog actions
  openDetail: (skill) => set({ detailSkill: skill }),
  closeDetail: () => set({ detailSkill: null }),

  openDelete: (skill, scope, projectPath) => {
    // 立即打开对话框
    set({
      deleteTarget: { skill, scope, projectPath },
      agentDetails: null,
      loadingAgentDetails: true,
    });
    // fire-and-forget: prefetch agent 详情
    apiGetAgentDetails({ scope, name: skill.name, projectPath })
      .then((details) => set({ agentDetails: details }))
      .catch((e) => console.warn('Failed to fetch agent details:', e))
      .finally(() => set({ loadingAgentDetails: false }));
  },
  closeDelete: () => set({ deleteTarget: null, agentDetails: null, loadingAgentDetails: false }),

  openAdd: (scope) => {
    const { selectedContext } = useContextStore.getState();
    openInstallWizard({
      entryPoint: 'skills-panel',
      scope,
      projectPath: scope === 'project' ? selectedContext : undefined,
    }).catch((e) => {
      console.error('[openAdd] Failed to open wizard:', e);
      toast.error(String(e));
    });
  },
  openAddWithPrefill: (prefill) => {
    openInstallWizard({
      entryPoint: 'discovery',
      scope: 'global',
      prefillSource: prefill.source,
      prefillSkillName: prefill.skillName,
    }).catch((e) => {
      console.error('[openAddWithPrefill] Failed to open wizard:', e);
      toast.error(String(e));
    });
  },
}));
