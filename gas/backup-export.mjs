// Owner-only export utility. No public dispatcher route or Drive operations.
import {entitiesToState,stateToEntities,canonical} from '../src/lib/entity-codec.js';
import {serializeBackup,parseBackup} from '../src/lib/domain.js';
export function exportRecoveryAppJSON(values){
 if(!values||typeof values!=='object'||Array.isArray(values))throw Error('BACKUP_EXPORT_VALUES_INVALID');
 const state=entitiesToState(values),roundTrip=stateToEntities(state);
 for(const key of Object.keys(values))if(!Object.prototype.hasOwnProperty.call(roundTrip,key)||canonical(roundTrip[key])!==canonical(values[key]))throw Error('BACKUP_EXPORT_RECORD_MISMATCH');
 const result=serializeBackup(state);
 // Exact existing importer contract; never invent a superficially similar file.
 parseBackup(result);return result;
}
