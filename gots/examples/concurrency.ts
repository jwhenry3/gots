// gots concurrency — TS syntax for Go's goroutines and channels.
// go(f, args...) -> go f(args...);  Channel<T> -> chan T;  new Channel<T>(n) -> make(chan T, n)
// ch.emit(v) -> ch <- v;            ch.recv() -> <-ch;      ch.close() -> close(ch)

import "fmt"
import * as time from "time"

function worker(id: Int, jobs: Channel<Int>, results: Channel<string>) {
    for (const j of jobs) {
        results.emit(`worker ${id} finished job ${j}`)
    }
}

function produce(jobs: Channel<Int>, n: Int) {
    for (let i = 1; i <= n; i++) {
        jobs.emit(i as Int)
    }
    jobs.close()
}

function main() {
    const jobs = new Channel<Int>(4)
    const results = new Channel<string>()

    go(worker, 1 as Int, jobs, results)
    go(worker, 2 as Int, jobs, results)
    go(produce, jobs, 6 as Int)

    for (let i = 0; i < 6; i++) {
        console.log(results.recv())
    }

    // plain goroutine call form
    go(function () {
        time.Sleep(10 * time.Millisecond)
        console.log("deferred hello")
    })
    time.Sleep(50 * time.Millisecond)
    console.log("done")
}
