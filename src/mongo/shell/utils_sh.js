sh = function() { return "try sh.help();" }

sh._checkMongos = function() {
    var x = db.runCommand( "ismaster" );
    if ( x.msg != "isdbgrid" )
        throw Error("not connected to a mongos");
}

sh._checkFullName = function( fullName ) {
    assert( fullName , "need a full name" )
    assert( fullName.indexOf( "." ) > 0 , "name needs to be fully qualified <db>.<collection>'" )
}

sh._adminCommand = function( cmd , skipCheck ) {
    if ( ! skipCheck ) sh._checkMongos();
    return db.getSisterDB( "admin" ).runCommand( cmd );
}

sh._getConfigDB = function() {
    sh._checkMongos();
    return db.getSiblingDB( "config" );
}

sh._dataFormat = function( bytes ){
   if( bytes < 1024 ) return Math.floor( bytes ) + "B"
   if( bytes < 1024 * 1024 ) return Math.floor( bytes / 1024 ) + "KiB"
   if( bytes < 1024 * 1024 * 1024 ) return Math.floor( ( Math.floor( bytes / 1024 ) / 1024 ) * 100 ) / 100 + "MiB"
   return Math.floor( ( Math.floor( bytes / ( 1024 * 1024 ) ) / 1024 ) * 100 ) / 100 + "GiB"
}

sh._collRE = function( coll ){
   return RegExp( "^" + RegExp.escape(coll + "") + "-.*" )
}

sh._pchunk = function( chunk ){
   return "[" + tojson( chunk.min ) + " -> " + tojson( chunk.max ) + "]"
}

sh.help = function() {
    print( "\tsh.addShard( host )                       server:port OR setname/server:port" )
    print( "\tsh.enableSharding(dbname)                 enables sharding on the database dbname" )
    print( "\tsh.shardCollection(fullName,key,unique)   shards the collection" );

    print( "\tsh.splitFind(fullName,find)               splits the chunk that find is in at the median" );
    print( "\tsh.splitAt(fullName,middle)               splits the chunk that middle is in at middle" );
    print( "\tsh.moveChunk(fullName,find,to)            move the chunk where 'find' is to 'to' (name of shard)");
    
    print( "\tsh.setBalancerState( <bool on or not> )   turns the balancer on or off true=on, false=off" );
    print( "\tsh.getBalancerState()                     return true if enabled" );
    print( "\tsh.isBalancerRunning()                    return true if the balancer has work in progress on any mongos" );

    print( "\tsh.disableBalancing(coll)                 disable balancing on one collection" );
    print( "\tsh.enableBalancing(coll)                  re-enable balancing on one collection" );

    print( "\tsh.addShardTag(shard,tag)                 adds the tag to the shard" );
    print( "\tsh.removeShardTag(shard,tag)              removes the tag from the shard" );
    print( "\tsh.addTagRange(fullName,min,max,tag)      tags the specified range of the given collection" );
    print( "\tsh.removeTagRange(fullName,min,max,tag)   removes the tagged range of the given collection" );

    print( "\tsh.status()                               prints a general overview of the cluster" )
}

sh.status = function( verbose , configDB ) { 
    // TODO: move the actual command here
    printShardingStatus( configDB , verbose );
}

sh.addShard = function( url ){
    return sh._adminCommand( { addShard : url } , true );
}

sh.enableSharding = function( dbname ) { 
    assert( dbname , "need a valid dbname" )
    return sh._adminCommand( { enableSharding : dbname } );
}

sh.shardCollection = function( fullName , key , unique ) {
    sh._checkFullName( fullName )
    assert( key , "need a key" )
    assert( typeof( key ) == "object" , "key needs to be an object" )
    
    var cmd = { shardCollection : fullName , key : key }
    if ( unique ) 
        cmd.unique = true;

    return sh._adminCommand( cmd );
}

sh.splitFind = function( fullName , find ) {
    sh._checkFullName( fullName )
    return sh._adminCommand( { split : fullName , find : find } );
}

sh.splitAt = function( fullName , middle ) {
    sh._checkFullName( fullName )
    return sh._adminCommand( { split : fullName , middle : middle } );
}

sh.moveChunk = function( fullName , find , to ) {
    sh._checkFullName( fullName );
    return sh._adminCommand( { moveChunk : fullName , find : find , to : to } )
}

sh.setBalancerState = function( onOrNot ) { 
    sh._getConfigDB().settings.update({ _id: "balancer" }, { $set : { stopped: onOrNot ? false : true } }, true );
}

sh.getBalancerState = function(configDB) {
    if (configDB === undefined)
        configDB = sh._getConfigDB();
    var x = configDB.settings.findOne({ _id: "balancer" } )
    if ( x == null )
        return true;
    return ! x.stopped;
}

sh.isBalancerRunning = function (configDB) {
    if (configDB === undefined)
        configDB = sh._getConfigDB();
    var x = configDB.locks.findOne({ _id: "balancer" });
    if (x == null) {
        print("config.locks collection empty or missing. be sure you are connected to a mongos");
        return false;
    }
    return x.state > 0;
}

sh.getBalancerHost = function(configDB) {
    if (configDB === undefined)
        configDB = sh._getConfigDB();
    var x = configDB.locks.findOne({ _id: "balancer" });
    if( x == null ){
        print("config.locks collection does not contain balancer lock. be sure you are connected to a mongos");
        return ""
    }
    return x.process.match(/[^:]+:[^:]+/)[0]
}

sh.stopBalancer = function( timeout, interval ) {
    sh.setBalancerState( false )
    sh.waitForBalancer( false, timeout, interval )
}

sh.startBalancer = function( timeout, interval ) {
    sh.setBalancerState( true )
    sh.waitForBalancer( true, timeout, interval )
}

sh.waitForDLock = function( lockId, onOrNot, timeout, interval ){
    // Wait for balancer to be on or off
    // Can also wait for particular balancer state
    var state = onOrNot
    var configDB = sh._getConfigDB();
    
    var beginTS = undefined
    if( state == undefined ){
        var currLock = configDB.locks.findOne({ _id : lockId })
        if( currLock != null ) beginTS = currLock.ts
    }
        
    var lockStateOk = function(){
        var lock = configDB.locks.findOne({ _id : lockId })

        if( state == false ) return ! lock || lock.state == 0
        if( state == true ) return lock && lock.state == 2
        if( state == undefined ) return (beginTS == undefined && lock) || 
                                        (beginTS != undefined && ( !lock || lock.ts + "" != beginTS + "" ) )
        else return lock && lock.state == state
    }
    
    assert.soon( lockStateOk,
                 "Waited too long for lock " + lockId + " to " + 
                      (state == true ? "lock" : ( state == false ? "unlock" : 
                                       "change to state " + state ) ),
                 timeout,
                 interval
    )
}

sh.waitForPingChange = function( activePings, timeout, interval ){
    
    var isPingChanged = function( activePing ){
        var newPing = sh._getConfigDB().mongos.findOne({ _id : activePing._id })
        return ! newPing || newPing.ping + "" != activePing.ping + ""
    }
    
    // First wait for all active pings to change, so we're sure a settings reload
    // happened
    
    // Timeout all pings on the same clock
    var start = new Date()
    
    var remainingPings = []
    for( var i = 0; i < activePings.length; i++ ){
        
        var activePing = activePings[ i ]
        print( "Waiting for active host " + activePing._id + " to recognize new settings... (ping : " + activePing.ping + ")" )
       
        // Do a manual timeout here, avoid scary assert.soon errors
        var timeout = timeout || 30000;
        var interval = interval || 200;
        while( isPingChanged( activePing ) != true ){
            if( ( new Date() ).getTime() - start.getTime() > timeout ){
                print( "Waited for active ping to change for host " + activePing._id + 
                       ", a migration may be in progress or the host may be down." )
                remainingPings.push( activePing )
                break
            }
            sleep( interval )   
        }
    
    }
    
    return remainingPings
}

sh.waitForBalancerOff = function( timeout, interval ){
    var pings = sh._getConfigDB().mongos.find().toArray()
    var activePings = []
    for( var i = 0; i < pings.length; i++ ){
        if( ! pings[i].waiting ) activePings.push( pings[i] )
    }
    
    print( "Waiting for active hosts..." )
    
    activePings = sh.waitForPingChange( activePings, 60 * 1000 )
    
    // After 1min, we assume that all hosts with unchanged pings are either 
    // offline (this is enough time for a full errored balance round, if a network
    // issue, which would reload settings) or balancing, which we wait for next
    // Legacy hosts we always have to wait for
    
    print( "Waiting for the balancer lock..." )
    
    // Wait for the balancer lock to become inactive
    // We can guess this is stale after 15 mins, but need to double-check manually
    try{ 
        sh.waitForDLock( "balancer", false, 15 * 60 * 1000 )
    }
    catch( e ){
        print( "Balancer still may be active, you must manually verify this is not the case using the config.changelog collection." )
        throw Error(e);
    }
        
    print( "Waiting again for active hosts after balancer is off..." )
    
    // Wait a short time afterwards, to catch the host which was balancing earlier
    activePings = sh.waitForPingChange( activePings, 5 * 1000 )
    
    // Warn about all the stale host pings remaining
    for( var i = 0; i < activePings.length; i++ ){
        print( "Warning : host " + activePings[i]._id + " seems to have been offline since " + activePings[i].ping )
    }
    
}

sh.waitForBalancer = function( onOrNot, timeout, interval ){
    
    // If we're waiting for the balancer to turn on or switch state or
    // go to a particular state
    if( onOrNot ){
        // Just wait for the balancer lock to change, can't ensure we'll ever see it
        // actually locked
        sh.waitForDLock( "balancer", undefined, timeout, interval )
    }
    else {
        // Otherwise we need to wait until we're sure balancing stops
        sh.waitForBalancerOff( timeout, interval )
    }
    
}

sh.disableBalancing = function( coll ){
    if (coll === undefined) {
        throw Error("Must specify collection");
    }
    var dbase = db
    if( coll instanceof DBCollection ) {
        dbase = coll.getDB()
    } else {
        sh._checkMongos();
    }

    dbase.getSisterDB( "config" ).collections.update({ _id : coll + "" }, { $set : { "noBalance" : true } })
}

sh.enableBalancing = function( coll ){
    if (coll === undefined) {
        throw Error("Must specify collection");
    }
    var dbase = db
    if( coll instanceof DBCollection ) {
        dbase = coll.getDB()
    } else {
        sh._checkMongos();
    }

    dbase.getSisterDB( "config" ).collections.update({ _id : coll + "" }, { $set : { "noBalance" : false } })
}

/*
 * Can call _lastMigration( coll ), _lastMigration( db ), _lastMigration( st ), _lastMigration( mongos ) 
 */
sh._lastMigration = function( ns ){
    
    var coll = null
    var dbase = null
    var config = null
    
    if( ! ns ){
        config = db.getSisterDB( "config" )
    }   
    else if( ns instanceof DBCollection ){
        coll = ns
        config = coll.getDB().getSisterDB( "config" )
    }
    else if( ns instanceof DB ){
        dbase = ns
        config = dbase.getSisterDB( "config" )
    }
    else if( ns instanceof ShardingTest ){
        config = ns.s.getDB( "config" )
    }
    else if( ns instanceof Mongo ){
        config = ns.getDB( "config" )
    }
    else {
        // String namespace
        ns = ns + ""
        if( ns.indexOf( "." ) > 0 ){
            config = db.getSisterDB( "config" )
            coll = db.getMongo().getCollection( ns )
        }
        else{
            config = db.getSisterDB( "config" )
            dbase = db.getSisterDB( ns )
        }
    }
        
    var searchDoc = { what : /^moveChunk/ }
    if( coll ) searchDoc.ns = coll + ""
    if( dbase ) searchDoc.ns = new RegExp( "^" + dbase + "\\." )
        
    var cursor = config.changelog.find( searchDoc ).sort({ time : -1 }).limit( 1 )
    if( cursor.hasNext() ) return cursor.next()
    else return null
}

sh._checkLastError = function( mydb ) {
    var errObj = mydb.getLastErrorObj();
    if (errObj.err)
        throw _getErrorWithCode(errObj, "error: " + errObj.err);
}

sh.addShardTag = function( shard, tag ) {
    var config = sh._getConfigDB();
    if ( config.shards.findOne( { _id : shard } ) == null ) {
        throw Error( "can't find a shard with name: " + shard );
    }
    config.shards.update( { _id : shard } , { $addToSet : { tags : tag } } );
    sh._checkLastError( config );
}

sh.removeShardTag = function( shard, tag ) {
    var config = sh._getConfigDB();
    if ( config.shards.findOne( { _id : shard } ) == null ) {
        throw Error( "can't find a shard with name: " + shard );
    }
    config.shards.update( { _id : shard } , { $pull : { tags : tag } } );
    sh._checkLastError( config );
}

sh.addTagRange = function( ns, min, max, tag ) {
    if ( bsonWoCompare( min, max ) == 0 ) {
        throw new Error("min and max cannot be the same");
    }

    var config = sh._getConfigDB();
    config.tags.update( {_id: { ns : ns , min : min } } , 
            {_id: { ns : ns , min : min }, ns : ns , min : min , max : max , tag : tag } , 
            true );
    sh._checkLastError( config );    
}

sh.removeTagRange = function( ns, min, max, tag ) {
    var config = sh._getConfigDB();
    // warn if the namespace does not exist, even dropped
    if ( config.collections.findOne( { _id : ns } ) == null ) {
        print( "Warning: can't find the namespace: " + ns + " - collection likely never sharded" );
    }
    // warn if the tag being removed is still in use
    if ( config.shards.findOne( { tags : tag } ) ) {
        print( "Warning: tag still in use by at least one shard" );
    }
    // max and tag criteria not really needed, but including them avoids potentially unexpected
    // behavior.
    config.tags.remove( { _id : { ns : ns , min : min } , max : max , tag : tag } );
    sh._checkLastError( config );
}

sh.getBalancerLockDetails = function(configDB) {
    if (configDB === undefined)
        configDB = db.getSiblingDB('config');
    var lock = configDB.locks.findOne({ _id : 'balancer' });
    if (lock == null) {
        return null;
    }
    if (lock.state == 0){
        return null;
    }
    return lock;
}

sh.getBalancerWindow = function(configDB) {
    if (configDB === undefined)
        configDB = db.getSiblingDB('config');
    var settings = configDB.settings.findOne({ _id : 'balancer' });
    if ( settings == null ) {
        return null;
    }
    if (settings.hasOwnProperty("activeWindow")){
        return settings.activeWindow;
    }
    return null
}

sh.getActiveMigrations = function(configDB) {
    if (configDB === undefined)
        configDB = db.getSiblingDB('config');
    var activeLocks = configDB.locks.find( { _id : { $ne : "balancer" }, state: {$eq:2} });
    var result = []
    if( activeLocks != null ){
        activeLocks.forEach( function(lock){
            result.push({_id:lock._id, when:lock.when});
        })
    }
    return result;
}

sh.getRecentFailedRounds = function(configDB) {
    if (configDB === undefined)
        configDB = db.getSiblingDB('config');
    var balErrs = configDB.actionlog.find({what:"balancer.round"}).sort({time:-1}).limit(5)
    var result = { count : 0, lastErr : "", lastTime : " "};
    if(balErrs != null) {
        balErrs.forEach( function(r){
            if(r.details.errorOccured){
                result.count += 1;
                result.lastErr = r.details.errmsg;
                result.lastTime = r.time;
            }
        })
    }
    return result;
}

/**
 * Returns a summary of chunk migrations that was completed either successfully or not
 * since yesterday. The format is an array of 2 arrays, where the first array contains
 * the successful cases, and the second array contains the failure cases.
 */
sh.getRecentMigrations = function(configDB) {
    if (configDB === undefined)
        configDB = sh._getConfigDB();
    var yesterday = new Date( new Date() - 24 * 60 * 60 * 1000 );

    // Successful migrations.
    var result = configDB.changelog.aggregate([
        {
            $match: {
                time: { $gt: yesterday },
                what: "moveChunk.from",
                'details.errmsg': { $exists: false },
                'details.note': 'success'
            }
        },
        {
            $group: {
                _id: {
                    msg: "$details.errmsg"
                },
                count : { $sum: 1 }
            }
        },
        {
            $project: {
                _id: { $ifNull: [ "$_id.msg", "Success" ] },
                count: "$count"
            }
        }
    ]).toArray();

    // Failed migrations.
    result = result.concat(configDB.changelog.aggregate([
        {
            $match: {
                time: { $gt: yesterday },
                what : "moveChunk.from",
                $or: [
                    { 'details.errmsg': { $exists: true }},
                    { 'details.note': { $ne: 'success' }}
                ]
            }
        },
        {
            $group: {
                _id: {
                    msg: "$details.errmsg",
                    from : "$details.from",
                    to: "$details.to"
                },
                count: { $sum: 1 }
            }
        },
        {
            $project: {
                _id: { $ifNull: [ '$_id.msg', 'aborted' ]},
                from: "$_id.from",
                to: "$_id.to",
                count: "$count"
            }
        }
    ]).toArray());

    return result;
};
