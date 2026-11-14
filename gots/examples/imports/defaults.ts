import fmt from "fmt"
import str from "strings"
import s from "os"

function main() {
    fmt.Println(str.ToUpper("default imports bind the package"))
    fmt.Println(s.Args.length)
}
