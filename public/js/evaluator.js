// c:\Users\MY PC\OneDrive\Desktop\abc\sniper v2\public\js\evaluator.js

window.localEvaluator = {
  async evaluate(listing, config) {
    try {
      const { tokenId, price } = listing;
      const { slug } = config;

      // RULE 1: Specific Token ID Trap (Priority 1)
      if (config.ruleStates.tokenId && config.specificTokenIds && config.specificTokenIds.size > 0) {
        if (config.specificTokenIds.has(tokenId.toString())) {
          const cap = (config.specificTokenMaxEth && config.specificTokenMaxEth > 0) 
            ? config.specificTokenMaxEth 
            : (config.maxFloorEth || Infinity);
            
          if (price <= cap) {
            console.log(`[Evaluator] Rule 1 Match: Specific Token #${tokenId}`);
            return {
              triggered: true,
              reason: `🎯 Target Token #${tokenId}: ${price} ETH <= Cap ${cap} ETH`
            };
          }
        }
      }

      // RULE 2: Rare Trait Hunter (Priority 2)
      if (config.ruleStates.trait && config.traitFilters && config.traitFilters.length > 0) {
        for (const filter of config.traitFilters) {
          const cap = filter.maxEth || config.traitMaxEth || Infinity;
          if (price <= cap) {
            let hasTrait = false;
            // Check via listing traits
            if (listing.traits && Array.isArray(listing.traits)) {
              hasTrait = listing.traits.some(t => t.trait_type === filter.traitType && t.value === filter.traitValue);
            }
            // Check via cacheDB if available and not found yet
            if (!hasTrait && window.cacheDB) {
              hasTrait = await window.cacheDB.hasTraitLocal(slug, tokenId, filter.traitType, filter.traitValue);
            }
            
            if (hasTrait) {
              console.log(`[Evaluator] Rule 2 Match: Trait ${filter.traitType}:${filter.traitValue}`);
              return {
                triggered: true,
                reason: `👑 Trait Match [${filter.traitType}: ${filter.traitValue}]: ${price} ETH <= Cap ${cap} ETH`
              };
            }
          }
        }
      }

      // RULE 3: Floor Underprice Trap (Priority 3)
      if (config.ruleStates.floor && config.maxFloorEth > 0) {
        if (price <= config.maxFloorEth) {
          console.log(`[Evaluator] Rule 3 Match: Floor Fat-Finger`);
          return {
            triggered: true,
            reason: `⚡ Floor Fat-Finger: ${price} ETH <= Target ${config.maxFloorEth} ETH`
          };
        }
      }

      // RULE 4: Top Rarity Rank Snipe (Priority 4)
      if (config.ruleStates.rarity && (config.maxRareEth > 0 || config.maxFloorEth > 0)) {
        const maxRareCap = config.maxRareEth > 0 ? config.maxRareEth : config.maxFloorEth;
        
        if (price <= maxRareCap) {
          let rank = null;
          
          // Step 1: Try IndexedDB lookup
          if (window.cacheDB) {
            rank = await window.cacheDB.getTokenRank(slug, tokenId);
          }
          
          // Step 2: If null AND weights exist, estimate rank from traits using IC scoring
          if ((rank === null || rank === undefined) && window.dynamicRarityCalc?.weights && listing.traits) {
            try {
              const weightsData = window.dynamicRarityCalc;
              let totalIC = 0;
              for (const t of listing.traits) {
                const key = `${t.trait_type}:${t.value}`;
                if (weightsData.weights && weightsData.weights[key]) {
                  totalIC += weightsData.weights[key];
                }
              }
              const numTypes = weightsData.traitTypes ? weightsData.traitTypes.length : 1;
              const ts = weightsData.totalSupply || 10000;
              const rc = weightsData.rankedCount || ts;
              
              const normalizedIC = totalIC / (Math.log2(ts) * numTypes);
              rank = Math.round(rc * (1 - normalizedIC));
            } catch (e) {
              console.error('[Evaluator] Error estimating rank', e);
            }
          }
          
          if (rank !== null && rank > 0 && rank <= config.maxRareRank) {
            console.log(`[Evaluator] Rule 4 Match: Rarity Rank ${rank}`);
            return {
              triggered: true,
              reason: `👑 Top Rarity #${rank} at ${price} ETH <= Target ${maxRareCap} ETH`
            };
          }
        }
      }

      // No rules matched
      return { triggered: false, reason: '' };
      
    } catch (e) {
      console.error('[Evaluator] Error during evaluation:', e);
      return { triggered: false, reason: '' };
    }
  }
};
