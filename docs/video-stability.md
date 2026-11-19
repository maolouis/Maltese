# 鍒疯棰戠ǔ瀹氭€э細鍊欓€夐槦鍒?+ 鐩存帴瀵艰埅

> 閫傜敤鐗堟湰 2.0.3锛堟湰鍦版敼閫狅紝鏈崌鐗堟湰鍙凤級銆傚搴斾唬鐮侊細
> `src-tauri/src/video/queue.rs`锛堢函閫昏緫锛夈€乣src-tauri/src/video/adapter.rs`锛堝€欓€夎剼鏈級銆?> `src-tauri/src/video/session.rs`锛堢紪鎺掞級銆乣scripts/video-stability-probe.mjs`锛堣嚜娴嬶級銆?
## 鑳屾櫙锛氫负浠€涔堜箣鍓嶄笉绋冲畾

鍘嗗彶鏃ュ織锛坄%APPDATA%\com.maolouis.maltese\video\logs\video-<date>.jsonl`锛夐噷鐨勫吀鍨嬪潖褰㈡€侊細

- `NAV_VERIFIED` 涔嬪悗 0 绉掑嚭鐜?`ITEM_DISCARDED reason=page_feed`锛氶〉闈㈣嚜宸辫烦鍥為椤碉紱
- `ITEM_ADVANCED` 涔嬪悗 39 绉掓病鏈変换浣曡繘搴?鈫?`SESSION_STALLED`锛?0 绉掓棤鍙樺寲灏辫嚜鏉€锛夛紱
- 鏇惧嚭鐜?9333 / 9334 涓や釜 CDP 绔彛鍚?profile 鍙屽疄渚嬨€?
鏍瑰洜鏄?*鎺ㄨ繘鏂瑰紡涓嶅彲鎺?*锛氭棫瀹炵幇闈犮€岀偣绗竴寮犲崱鐗?/ 鐐逛笅涓€涓寜閽?/ 婊氬姩 / `history.back()`銆嶏紝
椤甸潰 SPAs 浼氭妸杩欎簺鎿嶄綔瑙ｉ噴鎴愬洖棣栭〉锛屽鑸洰鏍囦篃涓嶅啀鏄垜浠鐨勯偅鏉¤棰戙€?
鏀归€犲師鍒欙細**纭畾鎬т紭鍏?*銆備笉鍐嶇偣鍑讳换浣曞崱鐗囷紱鍙粠椤甸潰鎵归噺鍙栭摼鎺ワ紝鐒跺悗閫愭潯 `Page.navigate`銆?
## 涓€銆佸€欓€夐槦鍒楃瓥鐣ワ紙`queue.rs`锛?
### 1. 鎵归噺鍙栭摼鎺?
椤甸潰鑴氭湰锛坄adapter::candidate_script`锛変竴娆℃€ц繑鍥?`{ state: [bvid鈥, hrefs: [鈥 }`锛?
1. **浼樺厛** `window.__INITIAL_STATE__`锛氭壂鎻?`recommendList` / `related` / `relatedList` /
   `bangumi` / `seasonList` 閲岀殑 `bvid`锛堜篃鍏煎 `bvid_str`銆乣videoData.bvid`锛夛紱
2. **鍏滃簳** `document.querySelectorAll('a[href*="/video/BV"], a[href*="/video/av"]')`
   鐨?href锛堥椤点€佹帹鑽愭祦銆佹挱鏀鹃〉鐩稿叧鎺ㄨ崘閮借兘鐢級锛?3. 闃熷垪瑙佸簳鏃跺厛鍥?*鐑棬/鎺掕姒?*鍐嶆姄锛歚https://www.bilibili.com/v/popular/all`銆?   `https://www.bilibili.com/v/popular/rank/all`锛堟姈闊冲洖棣栭〉锛夈€?
Rust 渚?`parse_candidates` 璐熻矗鎸?id 鍘婚噸锛坄state` 鍦ㄥ墠銆乣hrefs` 鍦ㄥ悗锛夛紝
`CandidateQueue::push_candidates` 鍏ラ槦鏃跺啀杩囨护锛?*宸查噰闆?/ 宸叉媺榛?/ 宸插湪闃熷垪**鐨勪竴寰嬭烦杩囥€?鍗曟琛ヨ揣涓婇檺 50 鏉★紝闃熷垪浣庝簬 8 鏉″氨琛ヨ揣锛屼繚璇佽繛缁噰闆嗕笉鏂祦銆?
姣忔琛ヨ揣钀戒竴鏉℃棩蹇楋紙`CANDIDATES`锛夛細

```
CANDIDATES n=32 queue=32 sample=https://www.bilibili.com/video/BV1xx https://www.bilibili.com/video/BV1yy https://www.bilibili.com/video/BV1zz
```

### 2. 閫愭潯鐩存帴瀵艰埅

姣忚疆锛氬彇闃熼 鈫?`Page.navigate(url)` 鈫?杞 `location.href` 鍛戒腑**璇?bvid** 鍚庢墠绠楀埌杈俱€?鍛戒腑鍒ゅ畾 `url_matches_video_id` 鍙湅璺緞閲岀殑瑙嗛 id锛屽拷鐣ワ細

- query锛歚?spm_id_from=333.788.playrecommendByOp.0`銆乣?vd_source=鈥銆乣?p=1`锛?- fragment锛歚#reply`锛?- 鏈熬鏂滄潬锛?- 鐩稿璺緞 `/video/BVxxx/`銆?
褰掍竴鍖栧悗鍙姣?`BV鈥 / `av鈥 / 鎶栭煶鏁板瓧 id锛岄伩鍏嶃€孶RL 闀垮緱鍍忎絾鎹簡瑙嗛銆嶈璇垽銆?
### 3. 鍔犺浇瀹屾垚鍒ゅ畾

navigate 涔嬪悗涓嶅彧鐪?URL锛岃繕瑕佺瓑椤甸潰**鍏抽敭淇℃伅灏辩华**锛坄PageProbe::is_ready`锛夛細

- `location.href` 鍛戒腑鏈熸湜 bvid锛?- `document.title` 闈炵珯鐐规爣棰橈紙`鍝斿摡鍝斿摡 (銈?銈?銇ゃ儹 骞叉澂~-bilibili`銆乣鎶栭煶-璁板綍缇庡ソ鐢熸椿` 绛夛紝`is_site_title`锛夛紱
- 瀛樺湪 `video` 鍏冪礌鎴?`og:title` 闈炵┖銆?
鏈€澶氱瓑 **8 绉?*锛堟瘡 350ms 杞涓€娆★級銆傝秴鏃惰 `NAV_TIMEOUT`锛岃 URL 璁颁竴娆″け璐ュ苟璺冲埌涓嬩竴鏉★紝
涓嶄細鍦ㄥ師鍦扮┖杞€?
## 浜屻€佸け璐ュ鐞?
### URL 澶辫触涓庨粦鍚嶅崟

- 鍗曟潯 URL 澶辫触 鈫?`URL_FAILED url=鈥?count=1`锛屽け璐ヨ鏁?+1锛岀户缁敤闃熷垪閲?*涓嬩竴鏉℃病閲囪繃鐨?*锛?- **杩炵画 2 娆?*澶辫触 鈫?`URL_BLACKLIST url=鈥?failures=2 blacklist=<鎬婚粦鍚嶅崟鏁?`锛?  涔嬪悗琛ヨ揣涓嶄細鍐嶅叆闃燂紱
- 閲囬泦鎴愬姛浼氭竻闆惰 URL 鐨勫け璐ヨ鏁帮紙`CandidateQueue::mark_collected` 鍚屾椂 `failures.remove`锛夈€?
澶辫触鏉ユ簮鍖呮嫭锛歚Page.navigate` 鎶ラ敊銆? 绉掑唴椤甸潰娌″氨缁€乣extract` 鎷夸笉鍒颁簨瀹炪€?浜嬪疄琚垽瀹氫负浼潯鐩紙`page_feed` / `site_title` / `not_video_page`锛夈€?
### 椤甸潰鍥為€€鑷剤锛坄TARGET_HEALTH`锛?
鍋滅暀閲囨牱鏃舵瘡 2 绉掓鏌ヤ竴娆?URL 鏄惁杩樻槸褰撳墠瑙嗛锛坄dwell_on_video`锛夈€備竴鏃﹀彂鐜颁笉鏄細

```
TARGET_HEALTH url=https://www.bilibili.com/ expect=BV1xxok鈥?ok=false action=next_candidate
```

绔嬪埢缁撴潫杩欐潯鐨勫仠鐣欍€佸け璐ヨ鏁?+1锛屼笅涓€杞洿鎺ュ彇闃熷垪閲岃繕娌￠噰杩囩殑涓嬩竴鏉°€?**涓嶄細**鍥炲ご鍙嶅 navigate 鍚屼竴涓?URL锛堟棫瀹炵幇鐨?3 娆￠噸瀵艰埅灏辨槸鍗℃鏉ユ簮涔嬩竴锛夈€?
### 鐧诲綍澧?/ 椋庢帶

- 椋庢帶锛堥獙璇佺爜銆侀闄╂í骞咃級锛歚RISK_CONTROL`锛屾湰杞仠姝紱
- 鐧诲綍澧欙細杩涘叆 `AwaitingLogin`锛岃惤 `LOGIN_REQUIRED`锛屾妸璇?URL 濉炲洖闃熼锛? 绉掑悗鍐嶈瘯
  锛堢櫥褰曞畬鎴愬悗鑷姩鍥炲埌 `Collecting`锛夈€?
## 涓夈€佹祻瑙堝櫒閲嶅惎锛氬彧鍦?CDP 瀹屽叏涓嶅彲鐢ㄦ椂

- 榛樿**涓嶉噸鍚祻瑙堝櫒**锛氶〉闈㈠紓甯搞€乁RL 澶辫触銆佸鑸秴鏃堕兘鍙崲涓嬩竴鏉¤棰戯紱
- CDP 杩炵画澶辫触 3 娆★紙`MAX_CDP_FAILURES`锛夆啋 鍏?`CDP_RECOVER` + 閲嶈繛锛?- 閲嶈繛 3 娆★紙`MAX_RECONNECT_FAILURES`锛変粛澶辫触 = CDP 瀹屽叏涓嶅彲鐢?鈫?鎵嶈蛋 `BROWSER_RESTART`锛?  鍏虫棫瀹炰緥 鈫?`browser::launch` 鈫?`wait_for_cdp` 鈫?杩炴柊绔彛銆?  閲嶅惎鍚?*蹇呴』閲嶅缓鍊欓€夐槦鍒?*锛堝厛鍥炴帹鑽愭祦銆侀噸鏂拌ˉ璐э級锛屾棩蹇楅噷鑳界湅鍒?  `BROWSER_RESTART ok=true port=鈥 涔嬪悗绱ц窡鏂扮殑 `CANDIDATES`銆?- 姣?10 绉掑仛涓€娆＄鍙ｄ綋妫€锛?333鈥?338 鍙厑璁?1 涓椿鐫€锛夛紝澶氬嚭鏉ョ殑鍏虫帀骞惰
  `BROWSER_ENFORCED_SINGLE closed=<n> kept_port=<port> alive=[鈥`銆?
## 鍥涖€佸彲瑙傛祴鎬?
姣忚疆鍥哄畾鍐?`ROUND`锛堟棤璁烘垚鍔?澶辫触锛夛細

```
ROUND n=3 url=https://www.bilibili.com/video/BV1hXWP6dEVL title=銆愯嫳闆勮仈鐩熴€慡16 鍐宠禌 items=2 queue=27 failed=1
```

鍋滄鏃跺啓 `SESSION_SUMMARY`锛堢敤鎴峰仠姝€佸埌鏃堕暱銆佸穿婧冮兘浼氬啓锛夛細

```
SESSION_SUMMARY collected=5 distinct=5 failed=1 reason=DurationLimit
```

- `collected`锛氭垚鍔熼噰闆嗚疆鏁帮紙鍚屼竴瑙嗛閲嶅璁″叆娆℃暟锛夛紱
- `distinct`锛氫笉鍚岃棰戞暟锛?- `failed`锛歎RL 澶辫触鏁帮紙鍚鑸秴鏃?椤甸潰鍥為€€锛夈€?
鍏朵粬鍏抽敭鐮侊細`NAV_ATTEMPT` / `NAV_VERIFIED` / `NAV_TIMEOUT` / `CANDIDATES` /
`CANDIDATES_EMPTY` / `TARGET_HEALTH` / `ITEM_COLLECTED` / `ITEM_DISCARDED` /
`URL_FAILED` / `URL_BLACKLIST` / `CDP_RECOVER` / `STALL_WATCH`銆?
## 浜斻€佽窇鑷祴鑴氭湰

鍓嶇疆锛氬簲鐢ㄥ凡鍦ㄨ繍琛岋紙鏈満 DSH API 鐩戝惉 `127.0.0.1:<port>`锛岀鍙?浠ょ墝鍦?`%APPDATA%\com.maolouis.maltese\dsh-api-port.txt`銆乣dsh-api-token.txt`锛夈€?
```powershell
# 榛樿锛? 鍒嗛挓銆佹瘡 15 绉掓墦鍗拌繘搴︺€侀〉鍐呭仠鐣?15 绉?node scripts/video-stability-probe.mjs

# 鑷畾涔夋椂闀?/ 椤靛唴鍋滅暀 / 杈撳嚭 JSON 鎶ュ憡
node scripts/video-stability-probe.mjs --minutes=6 --page-interval=15 --report=.tmp-video/run1.json
```

鑴氭湰琛屼负锛?
1. `POST /api/video/start`锛堣嚜鍔ㄨ鍙?`video/accounts.json` 閲岀殑 activeAccountId锛屼紭鍏堢敤宸茬櫥褰?profile锛?   `--no-account` 鍙叧闂級锛?2. 姣?15 绉掓墦鍗颁竴娆?`phase / items / filtered / steps / error / url`锛屽苟瀹炴椂鎵撳嵃
   `CANDIDATES`銆乣ROUND`銆乣ITEM_COLLECTED`銆乣URL_BLACKLIST` 绛夊叧閿棩蹇楋紱
3. 鍒扮偣 `POST /api/video/stop`锛岀瓑 2.5 绉掕惤鐩橈紝杈撳嚭銆屽叧閿棩蹇?+ 姹囨€汇€嶏紱
4. 閫€鍑虹爜锛歚0` = 閲囧埌 鈮? 鏉′笉鍚?`/video/BV`锛沗1` = 涓嶈冻锛沗2` = 搴旂敤娌¤捣 / API 杩炰笉涓娿€?
鑴氭湰鍙搴旂敤鏁版嵁鐩綍銆佸彧璋冪敤鏈満 API锛屼笉鏀逛换浣曚笟鍔℃暟鎹€?
## 鍏€佸父瑙佸け璐ヤ笌瀵圭瓥

| 鏃ュ織鐜拌薄 | 鍙兘鍘熷洜 | 瀵圭瓥 |
| --- | --- | --- |
| `CANDIDATES n=0 reason=script_failed` | CDP 椤甸潰娌″搷搴?/ 鑴氭湰鎶ラ敊 | 鐪嬬揣閭荤殑 `CDP_*`锛涜剼鏈細鑷姩 `CDP_RECOVER` |
| 杩炵画 `CANDIDATES_EMPTY fills=3` | 椤甸潰缁撴瀯鍙樹簡锛宍__INITIAL_STATE__` 涓?`a[href*="/video/BV"]` 閮芥姄涓嶅埌 | 鏇存柊 `adapter::candidate_script`锛涘厛鎵嬪姩寮€涓撶敤绐楀彛鐪嬮椤垫槸鍚︽甯?|
| `NAV_TIMEOUT` 杩炵画鍑虹幇 | 缃戠粶鎱?/ 鐧诲綍澧?/ 椤甸潰琚鎺?| 鐪?`actual=鈥?title=鈥锛涚櫥褰曞浼氳蛋 `LOGIN_REQUIRED` |
| `TARGET_HEALTH ok=false` 棰戠箒 | 椤甸潰鑷繁璺冲洖棣栭〉鎴栨崲浜嗚棰?| 姝ｅ父鑷剤锛氫細鎹笅涓€鏉★紱鑻ユ瘡鏉￠兘璺筹紝妫€鏌ヤ笓鐢ㄦ祻瑙堝櫒鏄惁琚姄鍙?|
| 澶ч噺 `URL_BLACKLIST` | 鍊欓€夐噷娣峰叆浜嗗け鏁?绉佷韩瑙嗛 | 姝ｅ父锛岄粦鍚嶅崟鍙奖鍝嶆湰杞紱涓嬩竴杞噸鏂版姄鍊欓€?|
| `SESSION_SUMMARY distinct=0` | 鍏ㄧ▼鍙繘浜嗛椤?| 鏌?`ROUND url=` 鏄惁鍏ㄦ槸棣栭〉锛涘繀瑕佹椂娓呮祻瑙堝櫒 profile 閲嶇櫥褰?|
| 涓や釜 CDP 绔彛鍚屾椂娲?| 涓婅疆瀹炰緥娌″叧骞插噣 | 鑷姩 `BROWSER_ENFORCED_SINGLE` 鏀跺熬锛涗粛鍙嶅鍑虹幇鏃舵墜鍔ㄥ叧涓撶敤娴忚鍣?|

## 涓冦€佸崟娴?
绾€昏緫鍗曟祴鍦?`src-tauri/src/video/queue.rs`锛堝€欓€夊幓閲嶄笌浼樺厛绾с€佸け璐ヨ鏁颁笌榛戝悕鍗曘€?闃熷垪鎺ㄨ繘銆乁RL 鍛戒腑鍒ゅ畾鍚?`?spm_id_from`锛変笌 `adapter.rs`锛堣剼鏈綋绉€佹棤鐐瑰嚮銆佸€欓€夋潵婧愶級銆?
```powershell
# 鍙湅鏂█缂栬瘧锛圕I 鍙嬪ソ锛?cargo check

# 璺?video 鍗曟祴锛圵indows 涓婃祴璇?exe 闇€瑕?comctl32 v6 manifest 鎵嶈兘鍔犺浇锛?# 瑙佷笅鏂硅鏄庯級
cargo test --lib video::queue::
```

Windows 鎻愮ず `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` 鏃讹紝鏄祴璇?exe 缂哄皯
`Microsoft.Windows.Common-Controls 6.0.0.0` 渚濊禆锛堟寮?exe 鐢?tauri-build 鍐欏叆 manifest锛?娴嬭瘯 exe 涓嶄細锛夈€傜敤 `mt.exe` 缁欐祴璇?exe 琛ヤ竴涓?manifest 鍗冲彲锛?
```powershell
mt -manifest test.manifest -outputresource:maltese_assistant_lib-<hash>.exe;#1
```

鍓嶇渚?`node --test tests/video-*.mjs` 淇濇寔鍏ㄧ豢锛堟湰娆℃病鏈夋敼鍓嶇绫诲瀷锛夈€