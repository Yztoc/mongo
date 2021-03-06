/**
 * Test that $** indexes can provide a covered solution, given an appropriate query and projection.
 *
 * Cannot implicitly shard accessed collections, because queries on a sharded collection cannot be
 * covered unless they include the shard key.
 *
 * @tags: [assumes_unsharded_collection]
 *
 * TODO: SERVER-36198: Move this test back to jstests/core/
 */
(function() {
    "use strict";

    load("jstests/aggregation/extras/utils.js");  // For arrayEq.
    load("jstests/libs/analyze_plan.js");         // For getPlanStages and isIndexOnly.

    const assertArrayEq = (l, r) => assert(arrayEq(l, r));

    const coll = db.all_paths_covered_query;
    coll.drop();

    // Confirms that the $** index can answer the given query and projection, that it produces a
    // covered solution, and that the results are identical to those obtained by a COLLSCAN. If
    // 'shouldFailToCover' is true, inverts the assertion and confirms that the given query and
    // projection do *not* produce a covered plan.
    function assertAllPathsProvidesCoveredSolution(query, proj, shouldFailToCover = false) {
        // Obtain the explain output for the given query and projection. We run the explain with
        // 'executionStats' so that we can subsequently validate the number of documents examined.
        const explainOut = assert.commandWorked(coll.find(query, proj).explain("executionStats"));
        const winningPlan = explainOut.queryPlanner.winningPlan;

        // Verify that the $** index provided the winning solution for this query.
        const ixScans = getPlanStages(winningPlan, "IXSCAN");
        assert.gt(ixScans.length, 0, tojson(explainOut));
        ixScans.forEach((ixScan) => assert(ixScan.keyPattern.hasOwnProperty("$_path")));

        // Verify that the solution is covered, and that no documents were examined. If the argument
        // 'shouldFailToCover' is true, invert the validation to confirm that it is NOT covered.
        assert.eq(!!explainOut.executionStats.totalDocsExamined, shouldFailToCover);
        assert.eq(isIndexOnly(coll.getDB(), winningPlan), !shouldFailToCover);

        // Verify that the query covered by the $** index produces the same results as a COLLSCAN.
        assertArrayEq(coll.find(query, proj).toArray(),
                      coll.find(query, proj).hint({$natural: 1}).toArray());
    }

    try {
        // Required in order to build $** indexes.
        assert.commandWorked(
            db.adminCommand({setParameter: 1, internalQueryAllowAllPathsIndexes: true}));

        // Create a new collection and build a $** index on it.
        const bulk = coll.initializeUnorderedBulkOp();
        for (let i = 0; i < 200; i++) {
            bulk.insert({a: {b: i, c: `${(i+1)}`}, d: (i + 2)});
        }
        assert.commandWorked(bulk.execute());
        assert.commandWorked(coll.createIndex({"$**": 1}));

        // Verify that the $** index can cover an exact match on an integer value.
        assertAllPathsProvidesCoveredSolution({"a.b": 10}, {_id: 0, "a.b": 1});

        // Verify that the $** index can cover an exact match on a string value.
        assertAllPathsProvidesCoveredSolution({"a.c": "10"}, {_id: 0, "a.c": 1});

        // Verify that the $** index can cover a range query for integer values.
        assertAllPathsProvidesCoveredSolution({"a.b": {$gt: 10, $lt: 99}}, {_id: 0, "a.b": 1});

        // Verify that the $** index can cover a range query for string values.
        assertAllPathsProvidesCoveredSolution({"a.c": {$gt: "10", $lt: "99"}}, {_id: 0, "a.c": 1});

        // Verify that the $** index can cover an $in query for integer values.
        assertAllPathsProvidesCoveredSolution({"a.b": {$in: [0, 50, 100, 150]}},
                                              {_id: 0, "a.b": 1});

        // Verify that the $** index can cover an $in query for string values.
        assertAllPathsProvidesCoveredSolution({"a.c": {$in: ["0", "50", "100", "150"]}},
                                              {_id: 0, "a.c": 1});

        // Verify that attempting to project the virtual $_path field from the $** keyPattern will
        // fail to do so and will instead produce a non-covered query. However, this query will
        // nonetheless output the correct results.
        const shouldFailToCover = true;
        assertAllPathsProvidesCoveredSolution(
            {d: {$in: [0, 25, 50, 75, 100]}}, {_id: 0, d: 1, $_path: 1}, shouldFailToCover);

        // Verify that predicates which produce inexact-fetch bounds are not covered by a $** index.
        assertAllPathsProvidesCoveredSolution(
            {d: {$elemMatch: {$eq: 50}}}, {_id: 0, d: 1}, shouldFailToCover);
    } finally {
        // Disable $** indexes once the tests have either completed or failed.
        db.adminCommand({setParameter: 1, internalQueryAllowAllPathsIndexes: false});
    }
})();