/**
 * 키별로 **생성 중인 약속**을 캐시한다 — 완성된 값이 아니라.
 *
 * 완성된 값을 캐시하면 생성이 비동기인 동안 창이 열린다. 두 호출이 나란히 들어와
 * 둘 다 캐시 미스를 보고, 둘 다 만들고, 나중 것이 앞 것을 덮어쓰지만 **앞 인스턴스도
 * 계속 살아서** 자기 일을 한다. 자유채팅 런타임에서는 그게 곧 같은 NPC 가 동시에 두
 * 번 발언하고(in-flight 가드가 인스턴스별이다) 예산이 두 배가 되는 것을 뜻했다.
 *
 * 그래서 약속 자체를 **동기적으로** 등록한다. 두 번째 호출은 첫 번째의 약속을 받는다.
 */
export function getOrCreateCached<T>(
  cache: Map<string, Promise<T | null>>,
  key: string,
  create: () => Promise<T | null>,
): Promise<T | null> {
  const existing = cache.get(key);
  if (existing) return existing;

  const creating = create().then(
    (value) => {
      // null 은 캐시하지 않는다 — "아직 만들 수 없다"이지 "없다"가 아니다.
      // (자유채팅에서는 채널에 NPC 가 아직 없는 상태다. 배치되면 다시 시도해야 한다.)
      if (value === null && cache.get(key) === creating) cache.delete(key);
      return value;
    },
    (err) => {
      if (cache.get(key) === creating) cache.delete(key);
      throw err;
    },
  );

  // `=== creating` 가드가 두 곳에 있는 이유: 늦게 끝난 실패가 **그 사이에 등록된 다른
  // 항목**을 지우면 안 된다. 자기가 넣은 것일 때만 지운다.
  cache.set(key, creating);
  return creating;
}
