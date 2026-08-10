import { useEffect, useRef, useState } from 'react';
import type { LogEvent } from 'shared';

/** 碰／吃／槓／自摸／胡／放槍，2 秒後自動消失。 */
const BANNER_MS = 2_000;

export type MahjongBannerKind = 'chi' | 'peng' | 'gang' | 'selfDraw' | 'win' | 'shoot';

export interface MahjongActionBanner {
  kind: MahjongBannerKind;
  text: string;
}

/**
 * 追蹤 room.log 裡新出現、跟這個暱稱有關的吃／碰／槓／胡事件，換成 2 秒的大字提示。
 * LogEvent 本身沒有時間戳記，「新出現」是靠比對陣列長度算的 —— 每次 log 變長，
 * 新增的那一段就當作剛剛發生。
 *
 * seenLength 的初始值刻意用 log.length（掛載當下的長度），不是寫死 0：
 * 按 F8 切換外觀會換掉 Chrome 包裝元件，逼 React 把底下整棵樹（含這個 hook 所在的
 * Seat／MahjongTable）解除掛載再重新掛載一次。如果初始值寫死 0，重新掛載後這個 ref
 * 會被重置成 0，接著就會把「掛載之前老早發生過」的整段歷史 log 當成剛剛發生，
 * 對著已經吃過／胡過的座位再彈一次大字。用掛載當下的長度當起點，就只認得「掛載之後
 * 才新增」的事件，不會被單純的重新掛載（切外觀、重新整理）誤觸發。
 */
export function useMahjongActionBanner(
  log: readonly LogEvent[],
  nickname: string,
): MahjongActionBanner | null {
  const [banner, setBanner] = useState<MahjongActionBanner | null>(null);
  const seenLength = useRef(log.length);
  const clearTimer = useRef<number | null>(null);

  useEffect(() => {
    const previousLength = seenLength.current;
    seenLength.current = log.length;
    if (log.length <= previousLength) return;

    const freshEvents = log.slice(previousLength);
    for (const event of freshEvents) {
      let next: MahjongActionBanner | null = null;
      if (event.t === 'mahjongMeld' && event.player === nickname) {
        next =
          event.kind === 'chi'
            ? { kind: 'chi', text: '吃！' }
            : event.kind === 'peng'
              ? { kind: 'peng', text: '碰！' }
              : { kind: 'gang', text: '槓！' };
      } else if (event.t === 'mahjongWin' && event.player === nickname) {
        next = event.winType === 'selfDraw' ? { kind: 'selfDraw', text: '自摸！' } : { kind: 'win', text: '胡！' };
      } else if (event.t === 'mahjongWin' && event.from === nickname) {
        next = { kind: 'shoot', text: '放槍！' };
      }
      if (next) {
        if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
        setBanner(next);
        clearTimer.current = window.setTimeout(() => setBanner(null), BANNER_MS);
      }
    }
  }, [log, nickname]);

  useEffect(
    () => () => {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    },
    [],
  );

  return banner;
}
