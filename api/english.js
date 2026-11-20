import { createEnglishService } from '../server/english-service.js';

// No live English OAuth / Drive write adapters are configured yet.
// This endpoint reports its unavailable state and rejects every write.
export default createEnglishService().handle;
